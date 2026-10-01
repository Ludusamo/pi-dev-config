#!/usr/bin/env python3
"""scaffold_notes.py - a scratchpad for the reviewer's own pass.

Writes <artifacts>/notes.md: frontmatter, a heading per changed file in diff
order with its +/- counts and a "read" checkbox, and a few empty sections for
thoughts that do not belong to one file.

notes.md is the reviewer's, not the agent's. It is never parsed into the
record and never posted; it is raw material the reviewer later dictates the
verdict from. The scaffold contains structure only - no observations, no scan
findings, no opinions.

Every changed file is listed, not only code: a note on a migration, a config
key or a changed test expectation is as useful as one on a .java file.

Usage:
    scaffold_notes.py --id STONE-1494                  # resolve via config
    scaffold_notes.py --artifacts ~/notes/pr-reviews/cod-backend/STONE-1494
    scaffold_notes.py --id STONE-1494 --update         # add files not yet listed
    scaffold_notes.py --id STONE-1494 --update --range <since_last_pass>
                                                       # ...and flag listed ones to re-read
    scaffold_notes.py --id STONE-1494 --force          # overwrite existing
"""
import argparse
import datetime as dt
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import prconfig  # noqa: E402

DIFF_OPTS = ["--ignore-cr-at-eol", "-M"]
FILE_HEADING = re.compile(r"^### (.+?)\s*$")
FILES_SECTION = "## Files"


def read_json(path):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, json.JSONDecodeError):
        return {}


def changed_files(repo_path, rng):
    """[(path, added, deleted, renamed_from)] in diff order. Binary reports '-'."""
    out = subprocess.run(["git", "-C", repo_path, "diff", *DIFF_OPTS, "--numstat", "-z", rng],
                         capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit(f"git diff --numstat {rng} failed: {out.stderr.strip()}")
    # -z: "add\tdel\tpath\0", or for a rename "add\tdel\t\0old\0new\0".
    tokens = out.stdout.split("\0")
    rows, i = [], 0
    while i < len(tokens):
        parts = tokens[i].split("\t")
        i += 1
        if len(parts) < 3:
            continue
        added, deleted, path = parts[0], parts[1], "\t".join(parts[2:])
        renamed_from = None
        if not path and i + 1 < len(tokens):
            renamed_from, path = tokens[i], tokens[i + 1]
            i += 2
        rows.append((path, added, deleted, renamed_from))
    return rows


def stat_of(added, deleted):
    return "binary" if added == "-" else f"+{added} -{deleted}"


def file_block(path, added, deleted, renamed_from=None):
    stat = stat_of(added, deleted)
    if renamed_from:
        stat += f", renamed from {renamed_from}"
    return [f"### {path}", "", f"- [ ] read  ({stat})", "", ""]


def build(artifacts, files, state, cls):
    passes = state.get("passes") or [{}]
    head_sha = (passes[-1].get("head_sha") or "")[:7]
    rid = state.get("id") or artifacts.name

    L = [
        "---",
        f"id: {rid}",
        f"repo: {state.get('repo') or ''}",
        f"head_sha: {head_sha}",
        f"range: {cls.get('range') or ''}",
        f"started: {dt.date.today().isoformat()}",
        "---",
        "",
        f"# Review notes: {rid}",
        "",
        "<!--",
        "Your scratchpad for the pass through the diff. Nothing here is posted",
        "and nothing here is parsed. Write as you go, in any shape; the verdict",
        "is transcribed from these notes later, with your confirmation.",
        "",
        "Optional shorthand, so notes are easy to triage at verdict time:",
        "",
        "  :88   line reference        ?  question for the author or yourself",
        "  !     probable blocker      ~  nitpick",
        "  >     follow-up / ticket    ok looked at it, fine",
        "",
        "Tick \"read\" when you have been through a file, so an interrupted",
        "review shows where you stopped.",
        "-->",
        "",
        "## First impressions",
        "",
        "<!-- Before reading closely: what do you expect this change to do? -->",
        "",
        "",
        FILES_SECTION,
        "",
        f"<!-- {len(files)} changed files, in diff order. -->",
        "",
    ]
    for f in files:
        L += file_block(*f)
    L += [
        "## Cross-cutting",
        "",
        "<!-- Things that span files: design, naming, scope, what is missing. -->",
        "",
        "",
        "## Questions",
        "",
        "<!-- For the author, or to resolve before concluding. -->",
        "",
        "",
        "## Not reviewed",
        "",
        "<!-- What you skipped or skimmed, and why. -->",
        "",
    ]
    return "\n".join(L)


def update(text, files, reread):
    """Insert headings for files not yet in notes.md.

    With reread, files already listed also get a re-read checkbox under their
    heading - used when files is the since_last_pass range, so the reviewer
    can see which notes may be stale. Returns (text, added, flagged).
    """
    lines = text.splitlines()
    present = {m.group(1): i for i, line in enumerate(lines) if (m := FILE_HEADING.match(line))}
    missing = [f for f in files if f[0] not in present]
    flagged = [f for f in files if f[0] in present] if reread else []
    today = dt.date.today().isoformat()

    # Bottom-up, so earlier indexes stay valid.
    for f in sorted(flagged, key=lambda f: present[f[0]], reverse=True):
        at = present[f[0]] + 1
        while at < len(lines) and not lines[at].strip():
            at += 1
        lines.insert(at, f"- [ ] re-read: changed again {today}  ({stat_of(f[1], f[2])})")

    if missing:
        try:
            start = lines.index(FILES_SECTION)
            insert_at = next((i for i in range(start + 1, len(lines))
                              if lines[i].startswith("## ")), len(lines))
            block = []
        except ValueError:
            insert_at = len(lines)
            block = ["", FILES_SECTION, ""]
        block += [f"<!-- Added {today}: changed since the last pass. -->", ""]
        for f in missing:
            block += file_block(*f)
        lines[insert_at:insert_at] = block

    return "\n".join(lines) + "\n", [f[0] for f in missing], [f[0] for f in flagged]


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--id")
    ap.add_argument("--artifacts", help="artifact directory; overrides --id")
    ap.add_argument("--repo-path", default=".")
    ap.add_argument("--range", help="diff range; defaults to classify.json's")
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--update", action="store_true",
                      help="add headings for changed files not yet in notes.md; with --range, "
                           "also flag already-listed files in that range for a re-read")
    mode.add_argument("--force", action="store_true", help="overwrite a non-empty notes.md")
    args = ap.parse_args()

    if args.artifacts:
        artifacts = Path(args.artifacts).expanduser()
    elif args.id:
        name = prconfig.repo_name_from(args.repo_path)
        _, root = prconfig.roots(name)
        artifacts = root / (name or "") / args.id
    else:
        sys.exit("pass --id or --artifacts")

    if not artifacts.is_dir():
        sys.exit(f"no artifact directory at {artifacts}")

    state = read_json(artifacts / ".state.json")
    cls = read_json(artifacts / "classify.json")
    repo_path = cls.get("repo_path") or args.repo_path
    rng = args.range or cls.get("range")
    if not rng:
        sys.exit("no range: run classify.py first, or pass --range")
    files = changed_files(repo_path, rng)

    out = artifacts / "notes.md"
    existing = out.read_text() if out.exists() else ""

    if args.update and existing.strip():
        text, added, flagged = update(existing, files, reread=bool(args.range))
        out.write_text(text)
        print(json.dumps({"updated": str(out), "added": added, "reread": flagged}, indent=2))
        return

    if existing.strip() and not args.force:
        sys.exit(f"{out} already has content - pass --update to add new files, "
                 "or --force to overwrite")

    out.write_text(build(artifacts, files, state, cls))
    print(json.dumps({"written": str(out), "files": len(files)}, indent=2))


if __name__ == "__main__":
    main()
