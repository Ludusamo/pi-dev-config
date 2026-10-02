#!/usr/bin/env python3
"""retro.py - aggregate review records into the numbers a retro decides on.

Reads every <artifact_root>/<repo>/<id>/record.json (the ledger is the glob,
there is no separate file) and prints a Markdown report: time by tier,
artifact use against generation, scan accuracy per rule, second-opinion
dispositions, `new` points, reviewer notes verbatim, and data-quality gaps.

It computes and flags; it never edits REVIEW_STANDARDS.md or the skill.
Flags are candidates for the reviewer to decide on, with the evidence beside
them - the retro proposes, a human lands.

Usage:
    retro.py                              # report across every repo
    retro.py --repo cod-backend --since 2026-09-01
    retro.py --json                       # the same aggregates, machine-readable
    retro.py backfill                     # show mechanical fields missing from records
    retro.py backfill --write             # ...and fill them from the artifact dirs
    retro.py escaped --repo cod-backend --id STONE-1494 \\
             --note "null fxRate on amend, fixed in STONE-1530"

backfill fills only fields a script derives (files, hunks, mechanical_ratio,
passes, artifacts_generated, scan.ran, tier). Reviewer fields are never touched.
"""
import argparse
import collections
import datetime as dt
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import prconfig  # noqa: E402

GENERATED = ("guide", "flow", "callgraph", "residue", "rollback", "scan")
SEVERITIES = ("blocker", "follow-up", "nitpick")

# --- flag thresholds ---------------------------------------------------------
# Mirrors references/standards-format.md: two false positives retire a rule.
FP_TO_RETIRE = 2
# A rule that fires this often and is never adopted is not earning its place.
FIRED_NEVER_ADOPTED = 2
# An artifact generated this many times and used in none is waste.
UNUSED_ARTIFACT = 3
# A class matching this share of reviews is not discriminating.
NON_DISCRIMINATING = 0.9
# Healthy band for deep_cut / risky_surface hit rates.
HEALTHY_DEEP = (0.10, 0.30)
# Below this adoption rate the second-opinion pass is noise.
AGENT_ADOPTION_FLOOR = 0.3
# Needed before a flag is more than an anecdote.
MIN_SAMPLE = 5

RULE_HEAD = re.compile(r"^(?P<id>R-\d+):\s*(?P<title>.+?)\s*$")
RULE_FIELD = re.compile(r"^-\s*(?P<k>Active|Severity|Checkable by|Applies when):\s*(?P<v>.+?)\s*$")


# --- loading -----------------------------------------------------------------

def artifact_root(override):
    if override:
        return prconfig.expand(override)
    return prconfig.roots(None)[1]


def load(root, repo=None, since=None):
    out = []
    for p in sorted(root.glob("*/*/record.json")):
        try:
            r = json.loads(p.read_text())
        except (OSError, json.JSONDecodeError) as e:
            print(f"warning: unreadable {p}: {e}", file=sys.stderr)
            continue
        if repo and r.get("repo") != repo:
            continue
        if since and (r.get("date") or "") < since:
            continue
        r["_dir"] = str(p.parent)
        out.append(r)
    return out


def read_json(path):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, json.JSONDecodeError):
        return None


def standards_rules(records):
    """{repo: {rule_id: {...}}} from each repo's REVIEW_STANDARDS.md, if findable."""
    out = {}
    for r in records:
        repo = r.get("repo")
        if repo in out:
            continue
        cls = read_json(Path(r["_dir"]) / "classify.json") or {}
        rp = cls.get("repo_path")
        path = Path(rp) / "REVIEW_STANDARDS.md" if rp else None
        if not path or not path.exists():
            continue
        rules, cur = {}, None
        for line in path.read_text().splitlines():
            if (m := RULE_HEAD.match(line)):
                cur = m.group("id")
                rules[cur] = {"title": m.group("title")}
            elif cur and (m := RULE_FIELD.match(line.strip())):
                rules[cur][m.group("k").lower()] = m.group("v")
            elif line.startswith("#"):
                cur = None
        out[repo] = {"path": str(path), "rules": rules}
    return out


def tier_of(r):
    """Tier as recorded, or 'legacy' for records written before tiers existed."""
    return r.get("tier") or "legacy"


# --- aggregation -------------------------------------------------------------

def aggregate(records):
    n = len(records)
    agg = {"reviews": n, "flags": []}
    flag = agg["flags"].append

    # Time
    mins = [r["wall_minutes"] for r in records if isinstance(r.get("wall_minutes"), int)]
    agg["minutes_total"] = sum(mins)
    by_tier = collections.defaultdict(list)
    for r in records:
        if isinstance(r.get("wall_minutes"), int):
            by_tier[tier_of(r)].append(r["wall_minutes"])
    agg["minutes_by_tier"] = {t: {"n": len(v), "mean": round(sum(v) / len(v), 1),
                                  "min": min(v), "max": max(v)}
                              for t, v in sorted(by_tier.items())}

    # Outcomes
    agg["verdicts"] = dict(collections.Counter(r.get("verdict") for r in records))
    pts = [p for r in records for p in r.get("points") or []]
    agg["points"] = {s: sum(1 for p in pts if p.get("severity") == s) for s in SEVERITIES}
    agg["points"]["total"] = len(pts)
    agg["points"]["new"] = sum(1 for p in pts if p.get("rule") == "new")
    zero = sum(1 for r in records if not r.get("points"))
    agg["zero_point_reviews"] = zero

    # Classification hit rates
    hits = collections.Counter(c for r in records for c in r.get("classification") or [])
    agg["classification_rate"] = {c: round(k / n, 2) for c, k in hits.most_common()} if n else {}
    if n >= MIN_SAMPLE:
        for c, k in hits.items():
            if k / n >= NON_DISCRIMINATING:
                flag(f"classification `{c}` matched {k}/{n} reviews - not discriminating")
        for c in ("deep_cut", "risky_surface"):
            rate = hits.get(c, 0) / n
            if rate > HEALTHY_DEEP[1]:
                flag(f"`{c}` hit rate {rate:.0%} is above the healthy "
                     f"{HEALTHY_DEEP[0]:.0%}-{HEALTHY_DEEP[1]:.0%} band")

    # Artifacts
    recs_used = [r for r in records if isinstance(r.get("artifacts_used"), list)]
    gen, used = collections.Counter(), collections.Counter()
    for r in recs_used:
        for a in r.get("artifacts_generated") or []:
            gen[a] += 1
        for a in r["artifacts_used"]:
            used[a] += 1
    # notes is scaffolded rather than generated; count it where notes.md exists.
    gen["notes"] = sum(1 for r in recs_used if (Path(r["_dir"]) / "notes.md").exists())
    agg["artifacts"] = {a: {"generated": gen[a], "used": used[a]}
                        for a in sorted(set(gen) | set(used)) if gen[a] or used[a]}
    agg["artifacts_basis"] = len(recs_used)
    for a, v in agg["artifacts"].items():
        if v["generated"] >= UNUSED_ARTIFACT and v["used"] == 0:
            flag(f"artifact `{a}` generated {v['generated']} times, used in none - drop it "
                 f"from the classes that ask for it")
        elif v["generated"] >= UNUSED_ARTIFACT and v["used"] / v["generated"] < 0.25:
            flag(f"artifact `{a}` used in {v['used']}/{v['generated']} reviews it was "
                 f"generated for")
    agg["artifacts_used_none"] = sum(1 for r in recs_used if not r["artifacts_used"])

    # Scan, only where it ran
    ran = [r for r in records if (r.get("scan") or {}).get("ran") is True]
    rules = collections.defaultdict(collections.Counter)
    for r in ran:
        s = r["scan"]
        for key in ("fired", "adopted", "false_positives", "not_raised", "not_reached",
                    "missed"):
            for rule in s.get(key) or []:
                rules[rule][key] += 1
    agg["scan_runs"] = len(ran)
    agg["scan_rules"] = {k: dict(v) for k, v in sorted(rules.items())}
    for rule, c in sorted(rules.items()):
        if c["false_positives"] >= FP_TO_RETIRE:
            flag(f"{rule}: {c['false_positives']} false positives - set `Active: false`")
        elif c["fired"] >= FIRED_NEVER_ADOPTED and not c["adopted"]:
            flag(f"{rule}: fired {c['fired']} times, never adopted "
                 f"({c['false_positives']} false positive, {c['not_raised']} not raised) - "
                 f"retire, or lower its severity")
        if c["missed"]:
            flag(f"{rule}: missed {c['missed']} time(s) - `Applies when` too narrow, or the "
                 f"check is unevaluable as written")
        if c["not_reached"] >= 2:
            flag(f"{rule}: not reached {c['not_reached']} times - impractical as written")

    # Second opinion
    ag = [p for r in records for p in r.get("agent_points") or []]
    disp = collections.Counter(p.get("disposition") for p in ag)
    agg["agent_points"] = {"runs": sum(1 for r in records if "agent_points" in r),
                           "points": len(ag), "dispositions": dict(disp)}
    if ag and len(ag) >= MIN_SAMPLE and disp["adopted"] / len(ag) < AGENT_ADOPTION_FLOOR:
        flag(f"second-opinion pass: {disp['adopted']}/{len(ag)} points adopted - noisy, "
             f"tighten it to points worth a blocker or follow-up")
    if disp["rejected - wrong"] >= 2:
        flag(f"second-opinion pass: {disp['rejected - wrong']} points misread the code")

    # Data quality
    gaps = collections.defaultdict(list)
    for r in records:
        rid = f"{r.get('repo')}/{r.get('id')}"
        for k in ("files", "hunks", "passes", "artifacts_generated", "artifacts_used",
                  "wall_minutes"):
            if k not in r or r[k] is None:
                gaps[k].append(rid)
        if "ran" not in (r.get("scan") or {}):
            gaps["scan.ran"].append(rid)
        if not r.get("not_reviewed"):
            gaps["not_reviewed"].append(rid)
    agg["gaps"] = {k: v for k, v in gaps.items()}
    agg["escaped_defects"] = sum(len(r.get("escaped_defects") or []) for r in records)
    return agg


def standards_flags(records, std):
    """Active ai rules that have never fired, per repo with a findable standards file."""
    out = []
    for repo, s in std.items():
        ran = [r for r in records if r.get("repo") == repo and (r.get("scan") or {}).get("ran")]
        if len(ran) < MIN_SAMPLE:
            continue
        fired = {x for r in ran for x in r["scan"].get("fired") or []}
        adopted = {x for r in ran for x in r["scan"].get("adopted") or []}
        for rid, rule in s["rules"].items():
            if rule.get("active", "").lower() != "true":
                continue
            if "ai" in rule.get("checkable by", "") and rid not in fired | adopted:
                out.append(f"{repo} {rid}: never fired across {len(ran)} scans - question it")
    return out


# --- report ------------------------------------------------------------------

def table(head, rows):
    """A column-aligned Markdown table."""
    cells = [head] + [[str(c) for c in r] for r in rows]
    w = [max(len(r[i]) for r in cells) for i in range(len(head))]
    fmt = lambda r: "| " + " | ".join(c.ljust(w[i]) for i, c in enumerate(r)) + " |"
    return "\n".join([fmt(cells[0]), "| " + " | ".join("-" * x for x in w) + " |"]
                     + [fmt(r) for r in cells[1:]])


ABBREV = {"narrow_behavioural": "nb", "wide_behavioural": "wb", "wide_mechanical": "wm",
          "deep_cut": "dc", "risky_surface": "rs", "quick": "q"}


def report(records, agg, std_flags):
    L = [f"# Review retro - {dt.date.today().isoformat()}", ""]
    if not records:
        return "# Review retro\n\nNo records found.\n"
    dates = sorted(r.get("date") or "" for r in records)
    L += [f"{agg['reviews']} reviews, {dates[0]} to {dates[-1]}, "
          f"{agg['minutes_total']} recorded minutes.",
          f"Verdicts: {', '.join(f'{k} {v}' for k, v in agg['verdicts'].items())}.",
          f"Points: {agg['points']['total']} ({agg['points']['blocker']} blocker, "
          f"{agg['points']['follow-up']} follow-up, {agg['points']['nitpick']} nitpick; "
          f"{agg['points']['new']} untagged `new`). "
          f"{agg['zero_point_reviews']} reviews raised nothing.", ""]
    if agg["reviews"] < MIN_SAMPLE:
        L += [f"Fewer than {MIN_SAMPLE} records - treat every flag as an anecdote.", ""]

    L += ["## Flags", ""]
    flags = agg["flags"] + std_flags
    L += [f"- {f}" for f in flags] or ["None."]
    L += [""]

    L += ["## Reviews", ""]
    rows = []
    for r in sorted(records, key=lambda r: (r.get("date") or "", r.get("repo") or "")):
        pts = r.get("points") or []
        rows.append([
            r.get("id"), r.get("repo"), r.get("date") or "", tier_of(r),
            "+".join(ABBREV.get(c, c) for c in r.get("classification") or []),
            r.get("files", "?"), r.get("hunks", "?"), r.get("wall_minutes", "?"),
            ", ".join(r["artifacts_used"]) if isinstance(r.get("artifacts_used"), list)
            and r["artifacts_used"] else ("none" if isinstance(r.get("artifacts_used"), list)
                                          else "?"),
            len(pts),
        ])
    L += [table(["ID", "Repo", "Date", "Tier", "Class", "Files", "Hunks", "Min", "Used",
                 "Pts"], rows), "",
          "Class: " + ", ".join(f"{v} = {k}" for k, v in ABBREV.items()) + ".", ""]

    L += ["## Time by tier", ""]
    L += [table(["Tier", "Reviews", "Mean min", "Range"],
                [[t, v["n"], v["mean"], f"{v['min']}-{v['max']}"]
                 for t, v in agg["minutes_by_tier"].items()]), ""]
    L += ["`legacy` is a record written before tiers existed.", ""]

    L += ["## Classification hit rate", ""]
    L += [table(["Class", "Rate"], [[c, f"{v:.0%}"] for c, v in
                                    agg["classification_rate"].items()]), ""]

    L += ["## Artifacts", "",
          f"Across the {agg['artifacts_basis']} records that state `artifacts_used`; "
          f"{agg['artifacts_used_none']} used nothing at all.", ""]
    L += [table(["Artifact", "Generated", "Used"],
                [[a, v["generated"], v["used"]] for a, v in agg["artifacts"].items()]), ""]

    L += ["## Scan", ""]
    if not agg["scan_runs"]:
        L += ["No record has a scan that ran.", ""]
    else:
        keys = ["fired", "adopted", "false_positives", "not_raised", "not_reached", "missed"]
        L += [f"{agg['scan_runs']} scans ran; records with `scan.ran: false` are excluded.", ""]
        L += [table(["Rule", "Fired", "Adopted", "False pos", "Not raised", "Not reached",
                     "Missed"],
                    [[rule] + [c.get(k, 0) for k in keys]
                     for rule, c in agg["scan_rules"].items()]), ""]

    ap = agg["agent_points"]
    L += ["## Second-opinion pass", ""]
    if not ap["points"]:
        L += [f"Ran {ap['runs']} times, raised nothing." if ap["runs"] else "Never ran.", ""]
    else:
        L += [f"Ran {ap['runs']} times, {ap['points']} points.", ""]
        L += [table(["Disposition", "Count"], sorted(ap["dispositions"].items())), ""]
        L += [table(["Review", "Point", "Disposition"],
                    [[r.get("id"), p.get("point"), p.get("disposition")]
                     for r in records for p in r.get("agent_points") or []]), ""]

    L += ["## `new` points", "",
          "Candidate rules: a `new` point recurring across reviews. Judge recurrence "
          "by meaning, not wording.", ""]
    news = [(r, p) for r in records for p in r.get("points") or [] if p.get("rule") == "new"]
    for r, p in news:
        text = " ".join((p.get("text") or "").split())
        L.append(f"- {r.get('repo')}/{r.get('id')} `{p.get('severity')}` "
                 f"`{p.get('path') or ''}` - {text}")
    L += [""] if news else ["None.", ""]

    L += ["## Reviewer notes", "", "Verbatim, oldest first.", ""]
    notes = [r for r in sorted(records, key=lambda r: r.get("date") or "")
             if r.get("reviewer_notes")]
    for r in notes:
        body = " / ".join(x.strip() for x in r["reviewer_notes"].splitlines() if x.strip())
        L.append(f"- **{r.get('repo')}/{r.get('id')}** ({tier_of(r)}): {body}")
    L += [""] if notes else ["None.", ""]

    L += ["## Data quality", ""]
    if agg["gaps"]:
        L += [table(["Field", "Missing in", "Records"],
                    [[k, len(v), ", ".join(v) if len(v) <= 4 else f"{', '.join(v[:4])}, ..."]
                     for k, v in sorted(agg["gaps"].items())]), ""]
        if any(k in agg["gaps"] for k in ("files", "hunks", "passes", "artifacts_generated",
                                          "scan.ran")):
            L += ["Mechanical gaps can be filled with `retro.py backfill --write`.", ""]
    else:
        L += ["No gaps.", ""]
    L += [f"Escaped defects recorded: {agg['escaped_defects']}. "
          "Without these, nothing here measures whether the process catches bugs - "
          "add them with `retro.py escaped`.", ""]
    return "\n".join(L)


# --- backfill / escaped ------------------------------------------------------

def backfill_one(r):
    """Mechanical fields missing from a record, derived from its artifact dir."""
    d = Path(r["_dir"])
    cls = read_json(d / "classify.json") or {}
    state = read_json(d / ".state.json") or {}
    sig = cls.get("signals") or {}
    add = {}
    for k in ("files", "hunks", "mechanical_ratio"):
        if k not in r and k in sig:
            add[k] = sig[k]
    if "passes" not in r and isinstance(state.get("passes"), list):
        add["passes"] = len(state["passes"])
    if "artifacts_generated" not in r:
        add["artifacts_generated"] = [a for a in GENERATED if (d / f"{a}.md").exists()]
    if "tier" not in r and cls.get("tier"):
        add["tier"] = cls["tier"]
    scan = dict(r.get("scan") or {})
    if "ran" not in scan:
        if (d / "scan.md").exists():
            scan = {"ran": True, **scan}
        else:
            reason = ("no REVIEW_STANDARDS.md" if sig.get("standards_found") is False
                      else "no scan.md - scan step skipped")
            # An empty scan block with no scan.md is a scan that never ran.
            if not any(scan.get(k) for k in scan):
                scan = {"ran": False, "reason": reason}
            else:
                scan = None  # rows but no scan.md: ambiguous, leave it alone
        if scan:
            add["scan"] = scan
    return add


def cmd_backfill(args, records):
    changed = 0
    for r in records:
        add = backfill_one(r)
        if not add:
            continue
        changed += 1
        print(f"{r.get('repo')}/{r.get('id')}: {', '.join(sorted(add))}")
        if args.write:
            path = Path(r["_dir"]) / "record.json"
            data = json.loads(path.read_text())
            data.update(add)
            path.write_text(json.dumps(data, indent=2) + "\n")
    if not changed:
        print("nothing to backfill")
    elif not args.write:
        print("\ndry run - pass --write to apply")


def cmd_escaped(args, root):
    path = root / args.repo / args.id / "record.json"
    if not path.exists():
        sys.exit(f"no record at {path}")
    data = json.loads(path.read_text())
    data.setdefault("escaped_defects", []).append(
        {"date": dt.date.today().isoformat(), "note": args.note})
    path.write_text(json.dumps(data, indent=2) + "\n")
    print(f"{path}: {len(data['escaped_defects'])} escaped defect(s)")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--artifact-root", help="override the artifact root")
    ap.add_argument("--repo", help="only this repo")
    ap.add_argument("--since", help="only records dated on or after YYYY-MM-DD")
    ap.add_argument("--json", action="store_true", help="aggregates as JSON")
    sub = ap.add_subparsers(dest="cmd")
    bf = sub.add_parser("backfill", help="fill mechanical fields missing from records")
    bf.add_argument("--write", action="store_true")
    es = sub.add_parser("escaped", help="append an escaped defect to a record")
    es.add_argument("--repo", required=True, dest="es_repo")
    es.add_argument("--id", required=True)
    es.add_argument("--note", required=True)
    args = ap.parse_args()

    root = artifact_root(args.artifact_root)
    if args.cmd == "escaped":
        args.repo = args.es_repo
        return cmd_escaped(args, root)
    records = load(root, args.repo, args.since)
    if args.cmd == "backfill":
        return cmd_backfill(args, records)

    agg = aggregate(records)
    std = standards_rules(records)
    sflags = standards_flags(records, std)
    if args.json:
        agg["standards_flags"] = sflags
        agg["standards_files"] = {k: v["path"] for k, v in std.items()}
        print(json.dumps(agg, indent=2))
    else:
        print(report(records, agg, sflags))


if __name__ == "__main__":
    main()
