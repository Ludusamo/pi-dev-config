#!/usr/bin/env python3
"""classify.py - litmus signals + proposed classification for a diff range.

Deterministic half of the PR review pipeline: counts, clusters and pattern
matches that an LLM should never be paid to compute. Emits facts ("signals")
separately from the derived call ("classification") so the model can overrule
the call without re-deriving the facts, and marks genuinely ambiguous cases
"undetermined" rather than guessing.

Usage:
    classify.py --repo-path ~/dev/trade-service --range <base>..<head>
    classify.py --repo-path . --range a1b2c3d..9f8e7d6 \
                --head-worktree ~/reviews/trade-service/OPST-4216/head

Consumes review_worktree.py output: .repo_path, .range, .worktrees.head
"""
import argparse
import collections
import difflib
import fnmatch
import json
import re
import subprocess
import sys
from pathlib import Path

TOK = re.compile(r"[A-Za-z_][A-Za-z0-9_]*|\d+|\"[^\"]*\"|'[^']*'|\S")
ASSERT = re.compile(
    r"\b(assert\w*|Assert\w*|expect|verify|thenReturn|willReturn|isEqualTo"
    r"|isTrue|isFalse|hasSize|containsExactly|shouldBe|toEqual|toBe)\b"
)
TESTP = re.compile(r"(^|/)(src/test|tests?)/|Tests?\.(java|kt)$|_test\.(py|go)$|\.spec\.(ts|tsx|js)$")
CODE = re.compile(r"\.(java|kt|py|ts|tsx|js|go|sql|rb|cs)$")
SHARED = re.compile(
    r"(^|/)(model|models|dto|dtos|contract|contracts|schema|schemas|interface|interfaces|proto)/"
    r"|\.(proto|avsc|graphql|thrift)$"
)
CONTRACT_DOC = re.compile(r"(^|/)docs?/.*\.(md|ya?ml|json)$|openapi|swagger|\.openapi\.")
MIGRATION = re.compile(r"(^|/)(migration|migrations|changelog|flyway|liquibase)/|(^|/)V\d+__")
# Comment and blank lines, across the languages in CODE. A javadoc rewrite in the
# same hunk as a field addition must not read as "this contract was modified".
NONCODE_LINE = re.compile(r"^\s*($|//|/\*|\*|#|--)")
# Trailing punctuation that changes when an item is appended to a list: the old
# last entry loses its closer and gains a comma. Appending to a record, enum,
# parameter list or array always shows up as one deletion without it.
TRAILING_PUNCT = " \t,;)}]{"

# --- thresholds -------------------------------------------------------------
# Calibrate these against the review ledger. Empirical starting points from
# trade-service: mechanical commit 0.92, bugfix 0.00, feature 0.29.
MECHANICAL_RATIO = 0.80          # >= this and no changed expectations -> mechanical
MECHANICAL_GREY = 0.60           # between grey and ratio -> undetermined
DEEP_CONSUMERS = 2               # shared symbol with >= N consumers -> deep cut
GREP_GLOBS = ["*.java", "*.kt", "*.ts", "*.tsx", "*.py", "*.go", "*.sql"]
# core.autocrlf on Windows otherwise reports every line of a file as changed,
# which would drown the mechanical ratio and the residue list in noise.
DIFF_OPTS = ["--ignore-cr-at-eol"]


def git(repo, *args, check=False):
    r = subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True)
    if check and r.returncode != 0:
        sys.exit(f"git {' '.join(args)} failed: {r.stderr.strip()}")
    return r.stdout


# --- diff parsing -----------------------------------------------------------

def parse_hunks(repo, rng):
    cur, path = None, None
    for line in git(repo, "diff", *DIFF_OPTS, "--unified=0", "--no-color", rng).splitlines():
        if line.startswith("+++ b/"):
            path = line[6:]
        elif line.startswith("+++ /dev/null"):
            path = None
        elif line.startswith("@@"):
            if cur:
                yield cur
            cur = {"file": path, "rm": [], "add": []}
        elif cur is not None:
            if line.startswith("-") and not line.startswith("---"):
                cur["rm"].append(line[1:])
            elif line.startswith("+") and not line.startswith("+++"):
                cur["add"].append(line[1:])
    if cur:
        yield cur


def substantive_deletions(hunks):
    """Removed lines per file, ignoring blanks and comments.

    Appending a field to a shared type is backward compatible; rewriting an
    existing line is what forces consumers to follow. Comment churn is neither,
    and counting it classified a doc rewrite as a breaking contract change.

    Also ignores a removed line that reappears among the added lines modulo
    trailing punctuation, which is what appending to any delimited list looks
    like in a diff.
    """
    def norm(line):
        return line.strip().rstrip(TRAILING_PUNCT)

    counts = collections.Counter()
    for h in hunks:
        if not h["file"]:
            continue
        added = {norm(a) for a in h["add"]}
        n = 0
        for line in h["rm"]:
            if NONCODE_LINE.match(line):
                continue
            if norm(line) in added:
                continue  # same line, different trailing punctuation
            n += 1
        counts[h["file"]] += n
    return counts


def substitutions(hunk):
    """Token substitutions turning rm into add, or None if structurally different.

    A hunk that replaces N lines with N lines, where each replacement is a
    token-level swap, is the signature of a mechanical transformation. Anything
    that adds/removes lines is structural and lands in the residue.
    """
    if not hunk["rm"] or len(hunk["rm"]) != len(hunk["add"]):
        return None
    pairs = set()
    for before, after in zip(hunk["rm"], hunk["add"]):
        tb, ta = TOK.findall(before), TOK.findall(after)
        matcher = difflib.SequenceMatcher(a=tb, b=ta, autojunk=False)
        for tag, i1, i2, j1, j2 in matcher.get_opcodes():
            if tag == "equal":
                continue
            pairs.add((" ".join(tb[i1:i2]), " ".join(ta[j1:j2])))
    return frozenset(pairs) or None


# --- standards --------------------------------------------------------------

def read_standards(path):
    """Extract risky-surface globs/topics and per-repo config from REVIEW_STANDARDS.md."""
    result = {"globs": [], "topics": [], "subsystem_re": None,
              "shared_contract_globs": [], "found": False}
    if not path:
        return result
    p = Path(path)
    if not p.exists():
        return result
    result["found"] = True

    section = None
    for line in p.read_text().splitlines():
        if line.lstrip().startswith("#"):
            low = line.lower()
            section = "risky" if "risky surface" in low else (
                "config" if "config" in low else None
            )
            continue
        stripped = line.strip()
        if section == "risky" and stripped.startswith(("-", "*")):
            raw = stripped.lstrip("-*").strip()
            item = raw.strip("`")
            if not item:
                continue
            # Backticks are the author's explicit "this is a path" marker, which
            # bare filenames like Dockerfile or build.gradle need - they contain
            # neither a slash nor a star. Unbackticked entries fall back to a
            # shape heuristic so an un-quoted glob still works.
            backticked = raw.startswith("`") and raw.endswith("`")
            looks_pathy = any(c in item for c in "/*?") or (
                "." in item and " " not in item
            )
            if backticked or looks_pathy:
                result["globs"].append(item)
            else:
                result["topics"].append(item)
        elif section == "config" and ":" in stripped:
            key, _, value = stripped.lstrip("-*").partition(":")
            key = key.strip().lower()
            value = value.strip()
            if key in ("subsystem_re", "subsystem regex"):
                result["subsystem_re"] = value.strip("`")
            elif key == "shared_contract_globs":
                result["shared_contract_globs"] = [
                    v.strip().strip("`") for v in value.split(",") if v.strip()
                ]
    return result


def match_glob(path, pattern):
    if fnmatch.fnmatch(path, pattern):
        return True
    # Allow bare directory entries like "src/auth" or "auth/".
    bare = pattern.strip("/")
    return f"/{bare}/" in f"/{path}" or path.startswith(f"{bare}/")


def subsystem_of(path, pattern):
    if pattern:
        m = re.search(pattern, path)
        if m:
            return m.group(1) if m.groups() else m.group(0)
    parts = [p for p in path.split("/")[:-1] if p]
    # Skip conventional source-root noise so the result means something.
    skip = {"src", "main", "test", "java", "kotlin", "python", "com", "org", "resources"}
    meaningful = [p for p in parts if p not in skip]
    return meaningful[-1] if meaningful else (parts[0] if parts else path)


def decide(matched, why):
    return {"matched": matched, "why": why}


# --- main -------------------------------------------------------------------

def main(args):
    repo = args.repo_path
    grep_root = args.head_worktree or repo

    numstat = [r.split("\t")
               for r in git(repo, "diff", *DIFF_OPTS, "--numstat", args.range).splitlines() if r]
    if not numstat:
        sys.exit(f"empty diff for range {args.range}")
    paths = [r[2] for r in numstat]
    raw_deletions = {r[2]: (int(r[1]) if r[1] != "-" else 0) for r in numstat}
    insertions = sum(int(r[0]) for r in numstat if r[0] != "-")
    deletions = sum(int(r[1]) for r in numstat if r[1] != "-")

    all_hunks = list(parse_hunks(repo, args.range))
    # Mechanical ratio is measured over CODE hunks only. A change that is 43 doc
    # files plus 5 code files scores as mechanical on doc-table churn otherwise,
    # and the code - the only part anyone reviews - gets the light treatment.
    hunks = [h for h in all_hunks if h["file"] and CODE.search(h["file"])]
    doc_hunks = len(all_hunks) - len(hunks)
    real_deletions = substantive_deletions(all_hunks)
    clusters, residue = collections.Counter(), collections.Counter()
    changed_expectations = collections.Counter()

    for h in hunks:
        sub = substitutions(h)
        if sub is None:
            residue[h["file"]] += 1
        else:
            clusters[sub] += 1
    for h in all_hunks:
        if h["file"] and TESTP.search(h["file"]):
            # A REMOVED assertion means an existing expectation moved, which
            # falsifies any "purely mechanical" claim. Added-only tests do not.
            n = sum(1 for line in h["rm"] if ASSERT.search(line))
            if n:
                changed_expectations[h["file"]] += n

    pure = sum(clusters.values())
    ratio = round(pure / len(hunks), 2) if hunks else 0.0

    std = read_standards(args.standards or default_standards(repo))
    subsystem_re = args.subsystem_re or std["subsystem_re"]

    shared = []
    for f in paths:
        if not CODE.search(f):
            continue
        # Per-repo globs win when present: the default regex is far too broad for
        # a BFF where every feature MR appends a field to some DTO.
        if std["shared_contract_globs"]:
            is_shared = any(match_glob(f, g) for g in std["shared_contract_globs"])
        else:
            is_shared = bool(SHARED.search(f))
        if not is_shared:
            continue
        symbol = Path(f).stem
        hits = git(grep_root, "grep", "-l", "-w", symbol, "--", *GREP_GLOBS).splitlines()
        consumers = [h for h in hits if h != f and not TESTP.search(h)]
        # Appending a field to a shared type is routine and backward compatible.
        # Deleting or rewriting an existing line is what forces consumers to follow.
        shared.append({"file": f, "symbol": symbol, "consumers": len(consumers),
                       "modified": real_deletions.get(f, 0) > 0,
                       "deletions": raw_deletions.get(f, 0),
                       "substantive_deletions": real_deletions.get(f, 0),
                       "sample": consumers[:5]})

    risky = []
    for g in std["globs"]:
        hit = [f for f in paths if match_glob(f, g)]
        if hit:
            risky.append({"pattern": g, "files": hit})

    subsystems = sorted({subsystem_of(f, subsystem_re) for f in paths if CODE.search(f)})
    migrations = [f for f in paths if MIGRATION.search(f)]
    contract_docs = [f for f in paths if CONTRACT_DOC.search(f)]

    signals = {
        "files": len(paths),
        "dirs": len({f.rsplit("/", 1)[0] for f in paths if "/" in f}),
        "subsystems": subsystems,
        "insertions": insertions,
        "deletions": deletions,
        "hunks": len(all_hunks),
        "code_hunks": len(hunks),
        "doc_hunks": doc_hunks,
        "pure_substitution_hunks": pure,
        "mechanical_ratio": ratio,
        "mechanical_ratio_basis": "code hunks only",
        "code_files": sum(1 for f in paths if CODE.search(f)),
        "top_clusters": [
            {"n": n, "sub": [f"{a} -> {b}" for a, b in sorted(s)][:3]}
            for s, n in clusters.most_common(3)
        ],
        "residue": [{"file": f, "hunks": n} for f, n in residue.most_common()],
        "existing_test_expectations_changed": dict(changed_expectations),
        "contract_docs_changed": contract_docs,
        "shared_contracts": shared,
        "migrations": migrations,
        "risky_matches": risky,
        "risky_topics_unmatched": std["topics"],
        "standards_found": std["found"],
    }

    deep_code = [s for s in shared if s["consumers"] >= DEEP_CONSUMERS and s["modified"]]
    additive_only = [s for s in shared if s["consumers"] >= DEEP_CONSUMERS and not s["modified"]]
    multi_subsystem = len(subsystems) >= 2

    code_files = sum(1 for f in paths if CODE.search(f))
    if not hunks:
        wide = decide(False, f"no code hunks - {doc_hunks} doc/config hunk(s) only")
    elif ratio >= MECHANICAL_RATIO and changed_expectations:
        # Corroboration check: a mechanical claim is falsified by moved expectations.
        wide = decide(False, f"mechanical_ratio {ratio} but existing test expectations "
                             f"changed in {len(changed_expectations)} file(s) - "
                             f"corroboration failed, treat as behavioural")
    elif ratio >= MECHANICAL_RATIO and code_files <= 1:
        # Mechanical but not wide: the trivial cell, floor artifacts only.
        wide = decide(False, f"mechanical_ratio {ratio} but only {code_files} code file(s) - "
                             f"trivial, not a wide cut")
    elif ratio >= MECHANICAL_RATIO:
        wide = decide(True, f"mechanical_ratio {ratio} over {len(hunks)} code hunks in "
                            f"{code_files} code files, no existing expectations changed")
    elif MECHANICAL_GREY <= ratio < MECHANICAL_RATIO:
        wide = decide("undetermined", f"mechanical_ratio {ratio} sits in the grey band "
                                      f"[{MECHANICAL_GREY}, {MECHANICAL_RATIO})")
    else:
        wide = decide(False, f"mechanical_ratio {ratio} below {MECHANICAL_GREY}")

    behavioural = decide(
        bool(changed_expectations) or ratio < MECHANICAL_RATIO,
        f"{len(changed_expectations)} file(s) with changed expectations; "
        f"{len(subsystems)} subsystem(s) touched",
    )

    if deep_code:
        deep = decide(True, f"shared contract {Path(deep_code[0]['file']).name} modified "
                            f"(not merely appended to), {deep_code[0]['consumers']} consumers")
    elif migrations:
        deep = decide(True, f"{len(migrations)} migration file(s) present")
    elif additive_only:
        s = additive_only[0]
        detail = (f" ({s['deletions']} deleted line(s), all comment or blank)"
                  if s["deletions"] else "")
        deep = decide(False, f"shared contract {Path(s['file']).name} touched but additive "
                             f"only{detail} - no consumer is forced to follow")
    elif contract_docs and multi_subsystem:
        deep = decide("undetermined", "contract doc changed across multiple subsystems, "
                                      "but no shared code type modified")
    else:
        deep = decide(False, "no shared code contract, migration, or cross-subsystem spread")

    if risky:
        risky_cls = decide(True, f"{len(risky)} risky-surface glob match(es)")
    elif std["topics"]:
        risky_cls = decide("undetermined",
                           f"{len(std['topics'])} prose topic(s) need judgement: "
                           f"{', '.join(std['topics'][:3])}")
    elif not std["found"]:
        risky_cls = decide("undetermined", "no REVIEW_STANDARDS.md found - cannot check")
    else:
        risky_cls = decide(False, "no risky-surface match")

    classification = {
        "wide_mechanical": wide,
        "narrow_behavioural": behavioural,
        "deep_cut": deep,
        "risky_surface": risky_cls,
    }

    wants = {
        "wide_mechanical": ["guide", "residue"],
        "narrow_behavioural": ["guide", "flow"],
        "deep_cut": ["guide", "flow", "callgraph"],
        "risky_surface": ["guide", "flow", "callgraph", "rollback"],
    }
    artifacts = {a for k, v in classification.items() if v["matched"] is True for a in wants[k]}
    artifacts.add("guide")  # floor: the default classification always gets a partial guide

    print(json.dumps({
        "range": args.range,
        "repo_path": str(Path(repo).resolve()),
        "signals": signals,
        "classification": classification,
        "artifacts": sorted(artifacts),
        "adjudicate": [k for k, v in classification.items() if v["matched"] == "undetermined"],
    }, indent=2))


def default_standards(repo):
    p = Path(repo) / "REVIEW_STANDARDS.md"
    return str(p) if p.exists() else None


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo-path", required=True)
    ap.add_argument("--range", required=True, help="base..head (use SHAs from review_worktree.py)")
    ap.add_argument("--standards", help="path to REVIEW_STANDARDS.md (default: <repo>/REVIEW_STANDARDS.md)")
    ap.add_argument("--head-worktree", help="where to run consumer greps (default: repo path)")
    ap.add_argument("--subsystem-re", help="override subsystem regex, first capture group wins")
    main(ap.parse_args())
