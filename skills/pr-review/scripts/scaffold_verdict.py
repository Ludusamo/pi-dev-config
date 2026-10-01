#!/usr/bin/env python3
"""scaffold_verdict.py - pre-fill verdict.md from the artifacts already on disk.

Everything the agent can know is filled in: frontmatter from .state.json and
classify.json, a file heading per changed code file in diff order, and a scan
disposition row per rule the scan reported on.

Everything only the reviewer can know is left as <not stated> or <fill>, which
verdict_to_record.py rejects. The scaffold is a form, never a draft - no point,
severity or verdict is ever invented here.

Usage:
    scaffold_verdict.py --id STONE-1494                  # resolve via config
    scaffold_verdict.py --artifacts ~/notes/pr-reviews/cod-backend/STONE-1494
    scaffold_verdict.py --id STONE-1494 --force          # overwrite existing
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
from mdtable import format_tables  # noqa: E402

CODE = re.compile(r"\.(java|kt|py|ts|tsx|js|go|sql|rb|cs)$")
RULE = re.compile(r"\bR-\d{3}\b")
MAX_FILE_HEADINGS = 12

SECTION_TO_SCAN = {
    "failures": "fail",
    "undetermined": "undet",
    "passed": "pass",
    "deferred to human": "deferred",
    "not applicable": "n/a",
}


def resolve_repo_path(stored, given):
    """classify.json's repo_path if absolute, else --repo-path.

    Older classify.json files recorded the path as given, often ".", which
    means nothing once you are no longer in that directory.
    """
    if stored and Path(stored).is_absolute():
        return stored
    return given or "."


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, json.JSONDecodeError):
        return default if default is not None else {}


def scan_rules(scan_path):
    """[(rule, scan_value)] in report order, excluding n/a."""
    if not Path(scan_path).exists():
        return [], []
    section, seen, rows, na = None, set(), [], []
    for line in Path(scan_path).read_text().splitlines():
        if line.startswith("## "):
            section = line[3:].strip().lower()
            continue
        value = SECTION_TO_SCAN.get(section or "")
        if not value:
            continue
        for rule in RULE.findall(line):
            if rule in seen:
                continue
            seen.add(rule)
            (na if value == "n/a" else rows).append((rule, value))
    return rows, [r for r, _ in na]


def changed_code_files(repo_path, rng):
    out = subprocess.run(["git", "-C", repo_path, "diff", "--name-only", rng],
                         capture_output=True, text=True).stdout.splitlines()
    return [f for f in out if f and CODE.search(f)]


def build(artifacts, repo_path_arg=None):
    state = read_json(artifacts / ".state.json")
    cls = read_json(artifacts / "classify.json")

    passes = state.get("passes") or [{}]
    head_sha = (passes[-1].get("head_sha") or "")[:7]
    matched = [k for k, v in (cls.get("classification") or {}).items()
               if v.get("matched") is True]
    repo_path = resolve_repo_path(cls.get("repo_path"), repo_path_arg)
    rng = cls.get("range")

    files = changed_code_files(repo_path, rng) if repo_path and rng else []
    rows, na = scan_rules(artifacts / "scan.md")

    L = []
    L += [
        "---",
        f"id: {state.get('id') or artifacts.name}",
        f"repo: {state.get('repo') or ''}",
        f"head_sha: {head_sha}",
        f"classification: [{', '.join(matched)}]",
        "verdict: <not stated>",
        f"reviewed: {dt.date.today().isoformat()}",
        "wall_minutes: <not stated>",
        "---",
        "",
        f"# Verdict: {state.get('id') or artifacts.name} - <not stated>",
        "",
        "<!-- verdict: approve | request changes | comment -->",
        "",
        "## Summary comment",
        "",
        "- [ ] posted",
        "",
        "```text",
        "",
        "```",
        "",
        "<!-- Headline, plus the classification and what it caused you to skip. -->",
        "",
        "## Line comments",
        "",
        "<!-- Entry shape, two-space indent on the block:",
        "",
        "- [ ] **:88** `blocker` `R-003`",
        "",
        "  ```text",
        "  comment as it should appear in GitLab",
        "  ```",
        "",
        "severity: blocker | nitpick | follow-up    rule: R-NNN | new",
        "-->",
        "",
    ]

    if files and len(files) <= MAX_FILE_HEADINGS:
        L.append("<!-- Changed code files in diff order. Delete any you have "
                 "nothing to say about. -->")
        L.append("")
        for f in files:
            L += [f"### {f}", ""]
    elif files:
        L += ["<!-- Changed code files in diff order:", ""]
        L += [f"  {f}" for f in files]
        L += ["", "Add a ### heading per file you comment on. -->", ""]

    L += [
        "## General comments",
        "",
        "<!-- Points with no single line to attach to. Same shape, no :line. -->",
        "",
        "## Not reviewed",
        "",
        "<!-- What the classification let you skip, in your words. -->",
        "",
        "## Scan disposition",
        "",
    ]

    if rows:
        L += [
            "<!-- Reviewer column: adopted | false positive | agreed | "
            "checked, ok | not reached | missed -->",
            "",
            "| Rule  | Scan said | Reviewer |",
            "| ----- | --------- | -------- |",
        ]
        L += [f"| {r} | {v} | <fill> |" for r, v in rows]
        if na:
            L += ["", f"<!-- not applicable, no decision needed: {', '.join(na)} -->"]
    else:
        L += ["<!-- No scan.md found. If REVIEW_STANDARDS.md exists, the scan "
              "step was skipped; say so here. -->"]

    L.append("")
    # Align before writing - this file is read in a plain text editor.
    return format_tables("\n".join(L)), {"files": len(files), "scan_rows": len(rows)}


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--id")
    ap.add_argument("--artifacts", help="artifact directory; overrides --id")
    ap.add_argument("--repo-path", default=".")
    ap.add_argument("--force", action="store_true", help="overwrite a non-empty verdict.md")
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

    out = artifacts / "verdict.md"
    if out.exists() and out.read_text().strip() and not args.force:
        sys.exit(f"{out} already has content - pass --force to overwrite")

    text, stats = build(artifacts, args.repo_path)
    out.write_text(text)
    print(json.dumps({"written": str(out), **stats}, indent=2))


if __name__ == "__main__":
    main()
