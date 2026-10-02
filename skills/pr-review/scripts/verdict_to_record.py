#!/usr/bin/env python3
"""verdict_to_record.py - derive record.json from a verdict.md.

The reviewer states each point once, in verdict.md. This extracts the
structured half rather than asking them to retype severities and rule tags
into a second file.

Refuses to invent. Unstated severities, an unstated verdict and an unstated
artifacts_used are errors, not defaults: the retro's only inputs are these
records, and a fabricated value corrupts the one measurement that matters.

The mechanical fields - files, hunks, mechanical_ratio, passes,
artifacts_generated, and whether the scan ran - come from the other files in
the artifact directory, so the reviewer never types them.

Writing always runs the --check validation first and writes nothing if it
fails.

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
# "not worth raising" exists because 9 of the first 10 agent points were filed
# as "rejected - intended" when the honest call was "real, but not worth it".
AGENT_DISPOSITIONS = {"adopted", "rejected - intended", "rejected - wrong",
                      "rejected - not worth raising"}
# Files whose presence in the artifact directory means the artifact was made.
GENERATED = ("guide", "flow", "callgraph", "residue", "rollback", "scan")
# What artifacts_used may name: the generated ones plus the reviewer's notes.
KNOWN_ARTIFACTS = set(GENERATED) | {"notes"}
VERDICTS = {"approve", "request changes", "comment"}
NOT_STATED = "<not stated>"

DISPOSITIONS = {
    "adopted", "false positive", "agreed", "checked, ok", "not reached",
    # a failure that was correct but not worth raising with the author
    "not raised",
    # the scan said pass but the reviewer found the thing it was checking for
    "missed",
}

# - [ ] **:88** `blocker` `R-003`
POINT = re.compile(
    r"^\s*-\s*\[(?P<done>[ xX])\]\s*"
    r"(?:\*\*:(?P<line>\d+)\*\*\s*)?"
    r"`(?P<severity>[^`]+)`\s*"
    r"`(?P<rule>[^`]+)`\s*$"
)
FILE_HEADING = re.compile(r"^###\s+(?P<path>\S+)\s*$")
FENCE = re.compile(r"^\s*(```|~~~)")
# notes.md lines that are scaffold structure, or say "looked, fine", not notes.
NOTES_NON_NOTE = re.compile(r"^\s*(-\s*(\[[ xX]\]\s*)?(read|re-read)\b|ok\b)", re.I)
# A freeform note that starts with a file: "Foo.ts:88 why?" or "`src/a/b.ts` ...".
NOTE_PATH = re.compile(r"^\s*[-*]?\s*`?(?P<path>[\w.@/-]+\.\w+)(:\d+)?`?[\s:,-]")
# notes.md sections whose lines are not notes about a file.
NOTES_SKIP_SECTIONS = ("questions", "not reviewed", "changed since last pass")
TITLE = re.compile(r"^#\s+Verdict:\s*\S+\s*-\s*(?P<verdict>.+?)\s*$")

# Which dispositions make sense for what the scan said. A failure marked
# "checked, ok" reads as agreement with the rule's check while the scan says it
# was violated - and it silently drops the finding from false_positives, which
# is the retro's only evidence for retiring a noisy rule.
COMPATIBLE = {
    # "agreed" on a failure is the legacy spelling of "not raised"; accepted
    # with a warning so older verdicts still parse.
    "fail": {"adopted", "false positive", "not raised", "agreed"},
    "undet": {"adopted", "false positive", "not raised", "agreed", "checked, ok",
              "not reached"},
    "pass": {"agreed", "missed"},
    "deferred": {"adopted", "checked, ok", "not reached"},
}
HINT = {
    ("fail", "checked, ok"): "use 'false positive' if the rule was wrong, "
                              "'not raised' if it was right but not worth raising, "
                              "'adopted' if you raised it",
    ("pass", "checked, ok"): "a passing rule needs no human check - use 'agreed', "
                             "or 'missed' if it should have failed",
    ("pass", "adopted"): "the scan passed this rule; if you raised it anyway, "
                         "the scan 'missed' it",
    ("deferred", "false positive"): "a deferred rule issued no verdict to be wrong "
                                    "- use 'checked, ok' or 'not reached'",
}
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


def strip_html_comments(text):
    """Blank out <!-- ... --> while preserving line numbering.

    The scaffold documents the entry shape with a worked example inside a
    comment. Without this, that example parses as a real review point and
    invents a blocker nobody raised.
    """
    return re.sub(r"<!--.*?-->",
                  lambda m: "\n" * m.group(0).count("\n"),
                  text, flags=re.S)


def read_json(path):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, json.JSONDecodeError):
        return None


def table_cells(raw):
    """Cells of a data row, or None for a header, separator or non-table line."""
    m = TABLE_ROW.match(raw)
    if not m:
        return None
    cells = [c.strip() for c in m.group("cells").split("|")]
    if not cells[0] or set(cells[0]) <= {"-", ":"}:
        return None
    return cells


def parse(path):
    text = Path(path).read_text()
    meta, body = parse_frontmatter(text)
    body = strip_html_comments(body)

    points, scan_rows, agent_rows, errors = [], [], [], []
    section, current_file = None, None
    not_reviewed, reviewer_notes, unparsed = [], [], []
    has_agent_section = False
    legacy_agreed = []
    # Line comments bookkeeping: inside a fenced block, and whether the last
    # significant line was a point (so the next fence is its comment block).
    in_fence, after_point = False, False

    lines = body.splitlines()
    for i, raw in enumerate(lines):
        if (m := SECTION.match(raw)):
            section = m.group("name").strip().lower()
            current_file = None
            in_fence, after_point = False, False
            if section == "agent points":
                has_agent_section = True
            continue

        if section == "line comments":
            if FENCE.match(raw):
                if not in_fence and not after_point:
                    unparsed.append(i)
                in_fence = not in_fence
                if not in_fence:
                    after_point = False
                continue
            if in_fence:
                continue
            if (m := FILE_HEADING.match(raw)):
                current_file = m.group("path")
                after_point = False
                continue
            if raw.strip() and not POINT.match(raw):
                unparsed.append(i)

        if section in ("line comments", "general comments") and (m := POINT.match(raw)):
            after_point = True
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

        if section == "reviewer notes":
            reviewer_notes.append(raw.rstrip())

        if section == "agent points" and (cells := table_cells(raw)):
            if len(cells) < 3 or cells[0].lower() == "point":
                continue
            point, where, decided = cells[0], cells[1], cells[2].lower()
            if decided not in AGENT_DISPOSITIONS:
                errors.append(f"line {i+1}: agent point disposition {decided!r} not one of "
                              f"{sorted(AGENT_DISPOSITIONS)}")
            agent_rows.append({"point": point, "where": where, "disposition": decided})

        if section == "scan disposition" and (cells := table_cells(raw)):
            if len(cells) < 3 or cells[0].lower() == "rule":
                continue
            rule, said, decided = cells[0], cells[1].lower(), cells[2].lower()
            if decided not in DISPOSITIONS:
                errors.append(f"line {i+1}: disposition {decided!r} not one of {sorted(DISPOSITIONS)}")
            elif said in COMPATIBLE and decided not in COMPATIBLE[said]:
                hint = HINT.get((said, decided))
                errors.append(
                    f"line {i+1}: {rule} scan said {said!r} but disposition is {decided!r}"
                    + (f" - {hint}" if hint else ""))
            if said in ("fail", "undet") and decided == "agreed":
                legacy_agreed.append(rule)
                decided = "not raised"
            scan_rows.append({"rule": rule, "scan": said, "reviewer": decided})

    title_verdict = next(
        (m.group("verdict").strip().lower()
         for line in body.splitlines() if (m := TITLE.match(line))), None)

    verdict = str(meta.get("verdict", NOT_STATED)).strip()
    if verdict not in VERDICTS:
        if title_verdict in VERDICTS:
            errors.append(
                f"frontmatter verdict is {verdict!r} but the title says "
                f"{title_verdict!r} - the record reads the frontmatter, so set it there")
        else:
            errors.append(f"frontmatter verdict {verdict!r} is not one of {sorted(VERDICTS)}")
    elif title_verdict in VERDICTS and title_verdict != verdict:
        errors.append(f"title says {title_verdict!r} but frontmatter says {verdict!r}")

    # artifacts_used is the reviewer's to state - never derived, never defaulted.
    used = meta.get("artifacts_used", NOT_STATED)
    warnings = []
    if legacy_agreed:
        warnings.append(f"{', '.join(legacy_agreed)}: 'agreed' on a failure is now spelled "
                        f"'not raised' - recorded as not raised")
    if not isinstance(used, list):
        errors.append(f"frontmatter artifacts_used is {used!r} - ask the reviewer which "
                      f"artifacts they used, e.g. [flow, guide, notes]; [] if none")
        used = None
    elif (unknown := [a for a in used if a not in KNOWN_ARTIFACTS]):
        warnings.append(f"artifacts_used names {unknown}, not one of {sorted(KNOWN_ARTIFACTS)}")

    artifacts = Path(path).resolve().parent
    cls = read_json(artifacts / "classify.json")
    state = read_json(artifacts / ".state.json")

    record = {
        "id": meta.get("id"),
        "repo": meta.get("repo"),
        "date": meta.get("reviewed"),
        "head_sha": meta.get("head_sha"),
        "classification": meta.get("classification", []),
        "verdict": verdict,
    }
    if cls and cls.get("tier"):
        record["tier"] = cls["tier"]

    # Mechanical fields. Omitted, with a warning, rather than guessed.
    signals = (cls or {}).get("signals") or {}
    if cls is None:
        warnings.append("no readable classify.json - files, hunks and mechanical_ratio omitted")
    for key in ("files", "hunks", "mechanical_ratio"):
        if key in signals:
            record[key] = signals[key]
    if meta.get("wall_minutes"):
        try:
            record["wall_minutes"] = int(meta["wall_minutes"])
        except ValueError:
            errors.append(f"wall_minutes {meta['wall_minutes']!r} is not a number")
    if state and isinstance(state.get("passes"), list):
        record["passes"] = len(state["passes"])
    else:
        warnings.append("no readable .state.json - passes omitted")

    record["points"] = points

    # A scan that never ran must not look like one that ran and found nothing.
    if (artifacts / "scan.md").exists():
        record["scan"] = {
            "ran": True,
            "fired": [r["rule"] for r in scan_rows if r["scan"] == "fail"],
            "adopted": [r["rule"] for r in scan_rows if r["reviewer"] == "adopted"],
            "false_positives": [r["rule"] for r in scan_rows
                                if r["reviewer"] == "false positive"],
            "not_raised": [r["rule"] for r in scan_rows if r["reviewer"] == "not raised"],
            "not_reached": [r["rule"] for r in scan_rows if r["reviewer"] == "not reached"],
            "missed": [r["rule"] for r in scan_rows if r["reviewer"] == "missed"],
        }
        if not scan_rows:
            warnings.append("scan.md exists but Scan disposition has no rows - run "
                            "scaffold_verdict.py --add-scan, or this reads as a scan "
                            "that found nothing")
    else:
        if signals.get("standards_found") is False:
            reason = "no REVIEW_STANDARDS.md"
        else:
            reason = "no scan.md - scan step skipped"
        record["scan"] = {"ran": False, "reason": reason}
        if scan_rows:
            warnings.append("scan disposition has rows but there is no scan.md - recorded as not run")

    record["not_reviewed"] = " ".join(not_reviewed) or None
    record["counts"] = {
        s: sum(1 for p in points if p["severity"] == s) for s in sorted(SEVERITIES)
    }
    record["artifacts_generated"] = [a for a in GENERATED if (artifacts / f"{a}.md").exists()]
    if used is not None:
        record["artifacts_used"] = used
    # Absent section: the second-opinion pass did not run. Empty table: it ran
    # and raised nothing. The two must stay distinguishable.
    if has_agent_section:
        record["agent_points"] = agent_rows
    record["reviewer_notes"] = "\n".join(reviewer_notes).strip() or None

    if unparsed:
        shown = ", ".join(str(n + 1 + body_offset(text)) for n in unparsed[:5])
        more = f" (+{len(unparsed) - 5} more)" if len(unparsed) > 5 else ""
        warnings.append(f"{len(unparsed)} unparsed line(s) under 'Line comments' at line(s) "
                        f"{shown}{more} - not a heading, point or comment block, so not "
                        f"in the record (leftover file list?)")

    if (orphans := orphan_notes(artifacts / "notes.md", points)):
        warnings.append(f"notes on {', '.join(orphans)} have no verdict entry - intended?")

    if not record["not_reviewed"]:
        warnings.append("'Not reviewed' is empty - classification chose the depth, so "
                        "what you skipped is the part worth recording")
    if "## summary comment" in body.lower() and not re.search(
            r"##\s+Summary comment\s*\n(.|\n)*?```", body):
        warnings.append("no summary comment block - nothing to paste into the MR overview")
    if not points and verdict == "request changes":
        warnings.append("verdict is 'request changes' but there are no review points")

    unposted = [p for p in points if not p["posted"]]
    return record, errors, unposted, warnings


def body_offset(text):
    """Lines taken by the frontmatter, to report file line numbers."""
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    return m.group(0).count("\n") if m else 0


def heading_matches(heading, path):
    """A verdict heading may abbreviate a path with '...'; match it as a wildcard."""
    if "..." not in heading:
        return heading == path
    pattern = ".*".join(re.escape(part) for part in heading.split("..."))
    return re.fullmatch(pattern, path) is not None


def orphan_notes(notes_path, points):
    """File headings in notes.md with a note under them but no verdict entry."""
    if not notes_path.exists():
        return []
    text = strip_html_comments(notes_path.read_text())
    noted, current, skip = [], None, False
    for raw in text.splitlines():
        if raw.startswith("## "):
            current = None
            skip = raw[3:].strip().lower().startswith(NOTES_SKIP_SECTIONS)
            continue
        if skip:
            continue
        if (m := FILE_HEADING.match(raw)):
            current = m.group("path")
            continue
        if not raw.strip() or NOTES_NON_NOTE.match(raw):
            continue
        # Freeform notes name their file inline; headings name it above.
        if (m := NOTE_PATH.match(raw)):
            target = m.group("path")
        else:
            target = current
        if target and target not in noted:
            noted.append(target)
    entries = {p["path"].rsplit(":", 1)[0] if re.search(r":\d+$", p["path"] or "")
               else p["path"] for p in points if p["path"]}
    # A freeform note may name only the file, not its path.
    return [f for f in noted
            if not any(heading_matches(e, f) or ("/" not in f and e.endswith("/" + f))
                       for e in entries)]


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

    record, errors, unposted, warnings = parse(args.verdict)

    for w in warnings:
        print(f"warning: {w}", file=sys.stderr)

    # The same validation gates --check and a real write: nothing is written
    # from a verdict that would fail --check.
    if errors:
        print("verdict.md is not complete:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        print("\nFill these in with the reviewer rather than guessing.", file=sys.stderr)
        if not args.check:
            print("record.json was not written.", file=sys.stderr)
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
