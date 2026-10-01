#!/usr/bin/env python3
"""verdict_to_record.py - derive record.json from a verdict.md.

The reviewer states each point once, in verdict.md. This extracts the
structured half rather than asking them to retype severities and rule tags
into a second file.

Refuses to invent. Unstated severities and an unstated verdict are errors,
not defaults: the retro's only inputs are these records, and a fabricated
severity corrupts the one measurement that matters.

Usage:
    verdict_to_record.py <artifacts>/verdict.md [--out record.json] [--check]
    verdict_to_record.py <artifacts>/verdict.md --check    # validate only
"""
import argparse
import json
import re
import sys
from pathlib import Path

SEVERITIES = {"blocker", "nitpick", "follow-up"}
VERDICTS = {"approve", "request changes", "comment"}
NOT_STATED = "<not stated>"

DISPOSITIONS = {
    "adopted", "false positive", "agreed", "checked, ok", "not reached",
}

# - [ ] **:88** `blocker` `R-003`
POINT = re.compile(
    r"^\s*-\s*\[(?P<done>[ xX])\]\s*"
    r"(?:\*\*:(?P<line>\d+)\*\*\s*)?"
    r"`(?P<severity>[^`]+)`\s*"
    r"`(?P<rule>[^`]+)`\s*$"
)
FILE_HEADING = re.compile(r"^###\s+(?P<path>\S+)\s*$")
SECTION = re.compile(r"^##\s+(?P<name>.+?)\s*$")
TABLE_ROW = re.compile(r"^\|(?P<cells>.+)\|\s*$")


def parse_frontmatter(text):
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    if not m:
        return {}, text
    meta = {}
    for line in m.group(1).splitlines():
        if ":" not in line:
            continue
        k, _, v = line.partition(":")
        v = v.strip()
        if v.startswith("[") and v.endswith("]"):
            v = [x.strip() for x in v[1:-1].split(",") if x.strip()]
        meta[k.strip()] = v
    return meta, text[m.end():]


def parse(path):
    text = Path(path).read_text()
    meta, body = parse_frontmatter(text)

    points, scan_rows, errors = [], [], []
    section, current_file = None, None
    not_reviewed = []

    lines = body.splitlines()
    for i, raw in enumerate(lines):
        if (m := SECTION.match(raw)):
            section = m.group("name").strip().lower()
            current_file = None
            continue
        if section == "line comments" and (m := FILE_HEADING.match(raw)):
            current_file = m.group("path")
            continue

        if section in ("line comments", "general comments") and (m := POINT.match(raw)):
            sev = m.group("severity").strip()
            rule = m.group("rule").strip()
            if sev == NOT_STATED or sev not in SEVERITIES:
                errors.append(f"line {i+1}: severity {sev!r} is not one of {sorted(SEVERITIES)}")
            body_text = extract_block(lines, i + 1)
            if body_text is None:
                errors.append(f"line {i+1}: point has no fenced comment block")
            points.append({
                "rule": rule,
                "severity": sev,
                "path": (f"{current_file}:{m.group('line')}"
                         if current_file and m.group("line") else current_file),
                "text": (body_text or "").strip(),
                "posted": m.group("done").lower() == "x",
            })
            continue

        if section == "not reviewed" and raw.strip() and not raw.startswith("#"):
            not_reviewed.append(raw.strip())

        if section == "scan disposition" and (m := TABLE_ROW.match(raw)):
            cells = [c.strip() for c in m.group("cells").split("|")]
            if len(cells) < 3 or cells[0].lower() in ("rule", "") or set(cells[0]) <= {"-", ":"}:
                continue
            rule, said, decided = cells[0], cells[1].lower(), cells[2].lower()
            if decided not in DISPOSITIONS:
                errors.append(f"line {i+1}: disposition {decided!r} not one of {sorted(DISPOSITIONS)}")
            scan_rows.append({"rule": rule, "scan": said, "reviewer": decided})

    verdict = str(meta.get("verdict", NOT_STATED)).strip()
    if verdict == NOT_STATED or verdict not in VERDICTS:
        errors.append(f"frontmatter verdict {verdict!r} is not one of {sorted(VERDICTS)}")

    record = {
        "id": meta.get("id"),
        "repo": meta.get("repo"),
        "date": meta.get("reviewed"),
        "head_sha": meta.get("head_sha"),
        "classification": meta.get("classification", []),
        "verdict": verdict,
        "points": points,
        "scan": {
            "fired": [r["rule"] for r in scan_rows if r["scan"] == "fail"],
            "adopted": [r["rule"] for r in scan_rows if r["reviewer"] == "adopted"],
            "false_positives": [r["rule"] for r in scan_rows
                                if r["reviewer"] == "false positive"],
            "not_reached": [r["rule"] for r in scan_rows if r["reviewer"] == "not reached"],
        },
        "not_reviewed": " ".join(not_reviewed) or None,
        "counts": {
            s: sum(1 for p in points if p["severity"] == s) for s in sorted(SEVERITIES)
        },
    }
    if meta.get("wall_minutes"):
        try:
            record["wall_minutes"] = int(meta["wall_minutes"])
        except ValueError:
            errors.append(f"wall_minutes {meta['wall_minutes']!r} is not a number")

    unposted = [p for p in points if not p["posted"]]
    return record, errors, unposted


def extract_block(lines, start):
    """Text of the first fenced block at or after `start`, before the next point."""
    fence = None
    out = []
    for raw in lines[start:start + 40]:
        stripped = raw.strip()
        if fence is None:
            if stripped.startswith("```"):
                fence = stripped[:3]
                continue
            if POINT.match(raw) or raw.startswith("#"):
                return None
            continue
        if stripped.startswith("```"):
            return "\n".join(out)
        out.append(raw.strip())
    return None


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("verdict")
    ap.add_argument("--out", help="default: record.json beside the verdict")
    ap.add_argument("--check", action="store_true", help="validate without writing")
    args = ap.parse_args()

    record, errors, unposted = parse(args.verdict)

    if errors:
        print("verdict.md is not complete:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        print("\nFill these in with the reviewer rather than guessing.", file=sys.stderr)
        sys.exit(1)

    if unposted:
        print(f"note: {len(unposted)} comment(s) still unchecked - "
              f"not yet pasted into GitLab", file=sys.stderr)

    if args.check:
        print(json.dumps({"ok": True, "points": len(record["points"]),
                          "unposted": len(unposted)}, indent=2))
        return

    out = Path(args.out) if args.out else Path(args.verdict).with_name("record.json")
    out.write_text(json.dumps(record, indent=2) + "\n")
    print(json.dumps({"written": str(out), "points": len(record["points"]),
                      "counts": record["counts"]}, indent=2))


if __name__ == "__main__":
    main()
