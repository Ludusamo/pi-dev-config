#!/usr/bin/env python3
"""Keep pi usage reports (cost-analysis + session-insights) as a ledger, so each
check covers only what happened since the last one, and changes you make can be
judged against the next check.

Layout (root = $PI_USAGE_DIR or ~/notes/pi-usage):

  <root>/<YYYY-MM-DD>/report.md        the written report (skeleton generated, LLM fills it)
  <root>/<YYYY-MM-DD>/metrics.json     window + comparable headline metrics
  <root>/<YYYY-MM-DD>/data/*.json      raw extractor output for that window
  <root>/changes.jsonl                 log of takeaways acted on (source of truth)
  <root>/CHANGES.md                    the same log, rendered for reading

Windows are half-open (after, before]. A new report starts where the previous
report's `before` ended, so nothing is analyzed twice.

Usage:
  usage_ledger.py window                         where the next report would start/end
  usage_ledger.py run [--after W] [--before W] [--dir D] [--no-content]
  usage_ledger.py categorize --dir D --map MAP.json
  usage_ledger.py compare [OLD_DIR NEW_DIR]      default: the two latest reports
  usage_ledger.py change add --title T [--detail D] [--metric KEY[=up|down] ...]
                             [--expect up|down] [--status proposed|applied]

--metric names a metrics.json key (see METRICS), model_share:<provider/model>,
or category_rate:<category> ($ per active hour, needs `categorize` on both reports).
A per-metric =up/=down overrides --expect for that metric.
  usage_ledger.py change set ID --status S [--note N]
  usage_ledger.py change list [--open]

Statuses: proposed -> applied -> kept | reverted, or dropped. A change is
"open" while proposed or applied; open changes are listed in every new report
with their metrics before and after.

Like the extractors, this does no interpretation. It runs them, keeps their
output, and lines numbers up so the calling agent can judge them.
"""
import argparse
import collections
import datetime as dt
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

_SHARED = Path(__file__).resolve().parent
sys.path.insert(0, str(_SHARED))
import pi_sessions as ps  # noqa: E402

SKILLS = _SHARED.parent
COST_SCRIPT = SKILLS / "cost-analysis" / "scripts" / "extract_costs.py"
INSIGHTS_SCRIPT = SKILLS / "session-insights" / "scripts" / "extract_sessions.py"
EXCHANGE_SCRIPT = _SHARED / "exchange_costs.py"
CONTENT_SCRIPT = _SHARED / "content_costs.py"

ROOT = Path(os.environ.get("PI_USAGE_DIR") or Path.home() / "notes" / "pi-usage")
LONG_SESSION_TURNS = 100
BIG_CONTEXT_TOKENS = 150_000
OPEN_STATUSES = ("proposed", "applied")
STATUSES = OPEN_STATUSES + ("kept", "reverted", "dropped")

# metric -> (label, which direction is better, format). Window-length-dependent
# totals are marked "-": compare them per hour/turn/day instead.
METRICS = {
    "cost_usd": ("Total spend (incl. subagents)", "-", "${:.2f}"),
    "subagent_cost_usd": ("Subagent spend", "-", "${:.2f}"),
    "subagent_share": ("Subagent share of spend", "-", "{:.0%}"),
    "days": ("Days in window", "-", "{:.1f}"),
    "active_days": ("Days with activity", "-", "{:d}"),
    "sessions": ("Sessions", "-", "{:d}"),
    "turns": ("Assistant turns", "-", "{:d}"),
    "active_hours": ("Active hours", "-", "{:.1f}"),
    "cost_per_active_day": ("$ per active day", "down", "${:.2f}"),
    "cost_per_active_hour": ("$ per active hour", "down", "${:.2f}"),
    "cost_per_turn": ("Main-session $ per turn", "down", "${:.4f}"),
    "cost_per_session": ("$ per session", "down", "${:.2f}"),
    "median_exchange_cost": ("Median $ per request", "down", "${:.3f}"),
    "share_cache_read": ("Cache-read share of spend", "down", "{:.0%}"),
    "share_cache_write": ("Cache-write share of spend", "down", "{:.0%}"),
    "share_output": ("Output share of spend", "-", "{:.0%}"),
    "cache_write_amortization": ("Cache reads per write", "up", "{:.1f}"),
    "top_session_cost": ("Most expensive session", "down", "${:.2f}"),
    "top_session_share": ("Top session share of spend", "down", "{:.0%}"),
    "max_peak_context_tokens": ("Largest peak context", "down", "{:,d}"),
    "sessions_over_150k_context": ("Sessions peaking > 150k context", "down", "{:d}"),
    "long_sessions_no_compaction": ("100+ turn sessions w/o compaction", "down", "{:d}"),
    "bash_carry_cost_usd": ("Est. bash output carry $", "down", "${:.2f}"),
    "bash_carry_per_turn": ("Est. bash carry $ per turn", "down", "${:.4f}"),
    "read_carry_cost_usd": ("Est. read output carry $", "down", "${:.2f}"),
    "read_carry_per_turn": ("Est. read carry $ per turn", "down", "${:.4f}"),
    # Size of each result, independent of how long sessions run - isolates
    # "smaller outputs" from "shorter sessions", which both cut carry cost.
    "bash_avg_result_tokens": ("Avg bash result size (tokens)", "down", "{:,d}"),
    "read_avg_result_tokens": ("Avg read result size (tokens)", "down", "{:,d}"),
    "error_exchange_share": ("Spend in requests with tool errors", "down", "{:.0%}"),
}


# ----------------------------------------------------------------- reports

def reports(root=ROOT):
    """Report dirs that have metrics.json, oldest window first."""
    out = []
    if not root.exists():
        return out
    for d in root.iterdir():
        m = d / "metrics.json"
        if d.is_dir() and m.exists():
            try:
                meta = json.loads(m.read_text())
            except json.JSONDecodeError:
                continue
            out.append((meta.get("window", {}).get("before") or "", d, meta))
    out.sort(key=lambda t: t[0])
    return [(d, meta) for _, d, meta in out]


def latest(root=ROOT, exclude=None):
    rs = [r for r in reports(root) if exclude is None or r[0].resolve() != Path(exclude).resolve()]
    return rs[-1] if rs else (None, None)


def now_iso():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def next_window(after=None, before=None):
    """after=None -> continue from the latest report; after="none" -> no lower bound."""
    prev_dir, prev = latest()
    if after is None and prev:
        after = prev["window"]["before"]
    if after == "none":
        after = None
    return after, before or now_iso(), prev_dir


def previous_report(before, exclude):
    """Latest report that ended at or before `before`, other than `exclude`."""
    b = ps.parse_when(before)
    rs = [(d, m) for d, m in reports()
          if d.resolve() != exclude.resolve() and ps.parse_when(m["window"]["before"]) <= b]
    return rs[-1] if rs else (None, None)


# ------------------------------------------------------------------ running

def run_script(script, out, after, before, extra=()):
    cmd = [sys.executable, str(script), "--scope", "all", "--out", str(out), *extra]
    if after:
        cmd += ["--after", after]
    if before:
        cmd += ["--before", before]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"{script.name} failed:\n{r.stderr}")
    return json.loads(Path(out).read_text())


def activity(after_ms, before_ms, cost_by_session):
    """Per-session active time and opening request inside the window, for the
    agent to sort into categories of work."""
    rows = []
    for path in ps.iter_session_files("all", None, after_ms=after_ms):
        header, entries = ps.read_session(path)
        if header is None:
            continue
        entries = ps.clip_entries(entries, after_ms, before_ms)
        msgs = [e for e in entries if e.get("type") == "message"]
        if not msgs:
            continue
        users = [e for e in msgs if (e.get("message") or {}).get("role") == "user"]
        first = ps.text_of(users[0]["message"].get("content")) if users else ""
        stamps = [ms for ms in (ps.to_epoch_ms(e.get("timestamp")) for e in entries) if ms]
        sid = header.get("id")
        rows.append({
            "session_id": sid,
            "cwd": header.get("cwd"),
            "start": ps.iso(min(stamps)) if stamps else None,
            "active_minutes": round(ps.active_seconds(entries) / 60, 1),
            "cost_usd": round(cost_by_session.get(sid, 0.0), 4),
            "user_messages": len(users),
            "first_request": " ".join(first.split())[:200],
        })
    rows.sort(key=lambda r: r["start"] or "")
    return rows


def activity_text(rows):
    home = str(Path.home())
    lines = []
    for r in rows:
        cwd = (r["cwd"] or "").replace(home, "~")
        lines.append(f"{(r['start'] or '')[5:16]} {r['active_minutes']:>6.1f}m ${r['cost_usd']:>7.2f} "
                     f"u{r['user_messages']:>3} {r['session_id'][:13]} {cwd[:34]:34} | {r['first_request'][:110]}")
    return "\n".join(lines) + "\n"


def compute_metrics(cost, cost_sessions, exchanges, act, after, before):
    t = cost["totals"]
    turns = t["turns"] or 0
    main = t["cost_usd"] or 0.0
    # Subagents run --no-session, so their spend lives only in the parent's tool
    # results. Whole-spend rates include it, or delegating would look like saving.
    total = t.get("cost_usd_including_subagents", main) or 0.0
    sub = (cost.get("subagents") or {}).get("cost_usd", 0.0)
    active_h = sum(r["active_minutes"] for r in act) / 60
    active_days = len({(r["start"] or "")[:10] for r in act if r["start"]})
    first = after or cost["meta"].get("first_activity")
    days = ((ps.parse_when(before) - ps.parse_when(first)) / 86_400_000) if first and before else None
    sess = cost_sessions.get("sessions", [])
    peaks = [(s.get("context_growth") or {}).get("peak_context_tokens") or 0 for s in sess]
    tools = {r["tool"]: r for r in cost.get("tool_output_cost_attribution", [])}
    shares = t.get("cost_share_by_component", {})
    top = cost["most_expensive_sessions"][0] if cost.get("most_expensive_sessions") else None

    def div(a, b):
        return round(a / b, 6) if b else None

    m = {
        "cost_usd": round(total, 4),
        "subagent_cost_usd": round(sub, 4),
        "subagent_share": div(sub, total),
        "days": round(days, 2) if days is not None else None,
        "active_days": active_days,
        "sessions": cost["meta"]["sessions_analyzed"],
        "turns": turns,
        "active_hours": round(active_h, 2),
        "cost_per_active_day": div(total, active_days),
        "cost_per_active_hour": div(total, active_h),
        "cost_per_turn": div(main, turns),
        "cost_per_session": t.get("avg_cost_per_session"),
        "median_exchange_cost": exchanges["totals"].get("median_cost_per_exchange"),
        "share_cache_read": shares.get("cacheRead"),
        "share_cache_write": shares.get("cacheWrite"),
        "share_output": shares.get("output"),
        "cache_write_amortization": t.get("cache", {}).get("write_amortization"),
        "top_session_cost": top["cost_usd"] if top else None,
        "top_session_share": div(top["cost_usd"], total) if top else None,
        "max_peak_context_tokens": max(peaks) if peaks else 0,
        "sessions_over_150k_context": sum(1 for p in peaks if p > BIG_CONTEXT_TOKENS),
        "long_sessions_no_compaction": sum(1 for s in sess if s["turns"] >= LONG_SESSION_TURNS
                                           and not s.get("compactions")),
        "bash_carry_cost_usd": (tools.get("bash") or {}).get("est_carry_cost_usd", 0.0),
        "bash_carry_per_turn": div((tools.get("bash") or {}).get("est_carry_cost_usd", 0.0), turns),
        "read_carry_cost_usd": (tools.get("read") or {}).get("est_carry_cost_usd", 0.0),
        "read_carry_per_turn": div((tools.get("read") or {}).get("est_carry_cost_usd", 0.0), turns),
        "bash_avg_result_tokens": (tools.get("bash") or {}).get("avg_result_tokens"),
        "read_avg_result_tokens": (tools.get("read") or {}).get("avg_result_tokens"),
        "error_exchange_share": exchanges.get("error_costs", {}).get("share_of_spend"),
    }
    model_share = {r["model"]: r["share_of_spend"] for r in cost.get("by_model", [])}
    return m, model_share


# ------------------------------------------------------------------ display

def fmt(key, v):
    if v is None:
        return "-"
    f = METRICS.get(key, (key, "-", "{}"))[2]
    try:
        return f.format(int(v) if "d}" in f else v)
    except (ValueError, TypeError):
        return str(v)


def verdict(key, old, new):
    better = METRICS.get(key, (None, "-"))[1]
    if old is None or new is None or better == "-":
        return ""
    if abs(new - old) <= 1e-9 or (old and abs(new - old) / abs(old) < 0.05):
        return "flat"
    up = new > old
    return "better" if (up == (better == "up")) else "worse"


def table(headers, rows):
    """Pretty-printed Markdown table, columns aligned for a monospace font."""
    cols = list(zip(*([headers] + rows))) if rows else [[h] for h in headers]
    widths = [max(len(str(c)) for c in col) for col in cols]
    line = lambda r: "| " + " | ".join(str(c).ljust(w) for c, w in zip(r, widths)) + " |"
    out = [line(headers), "|" + "|".join("-" * (w + 2) for w in widths) + "|"]
    out += [line(r) for r in rows]
    return "\n".join(out)


def metric_value(meta, key):
    if key.startswith("category_rate:"):
        c = ((meta or {}).get("categories") or {}).get(key.split(":", 1)[1])
        return round(c["cost_usd"] / c["active_hours"], 4) if c and c["active_hours"] else None
    if key.startswith("model_share:"):
        if not meta:
            return None
        return (meta.get("model_share") or {}).get(key.split(":", 1)[1], 0.0)  # unused = 0%
    return (meta.get("metrics") or {}).get(key)


def compare_table(old, new):
    rows = []
    for k in METRICS:
        a, b = metric_value(old, k), metric_value(new, k)
        rows.append([METRICS[k][0], fmt(k, a), fmt(k, b), verdict(k, a, b)])
    models = sorted(set(old.get("model_share") or {}) | set(new.get("model_share") or {}))
    for mdl in models:
        a = (old.get("model_share") or {}).get(mdl, 0.0)
        b = (new.get("model_share") or {}).get(mdl, 0.0)
        rows.append([f"Share: {mdl}", f"{a:.0%}", f"{b:.0%}", ""])
    return table(["Metric", window_label(old), window_label(new), "Change"], rows)


def window_label(meta):
    w = meta.get("window", {})
    a = (w.get("after") or meta.get("first_activity") or "start")[:10]
    return f"{a} to {(w.get('before') or '')[:10]}"


# ------------------------------------------------------------------ changes

def changes_path():
    return ROOT / "changes.jsonl"


def load_changes():
    p = changes_path()
    if not p.exists():
        return []
    return [json.loads(l) for l in p.read_text().splitlines() if l.strip()]


def save_changes(items):
    ROOT.mkdir(parents=True, exist_ok=True)
    changes_path().write_text("".join(json.dumps(c) + "\n" for c in items))
    render_changes(items)


def render_changes(items):
    lines = ["# pi usage - changes log", "",
             "Takeaways from usage reports that were acted on, and whether they worked.",
             "Generated from `changes.jsonl` by `usage_ledger.py` - edit through `change add` / `change set`.", ""]
    rows = [[c["id"], c["status"], c["logged"][:10], c["title"],
             ", ".join(c.get("metrics") or []) or "-", c.get("expect") or "-",
             (c.get("baseline_report") or "-")] for c in items]
    lines.append(table(["ID", "Status", "Logged", "Change", "Metrics", "Expect", "Baseline"], rows))
    for c in items:
        lines += ["", f"## {c['id']} - {c['title']}", ""]
        if c.get("detail"):
            lines.append(c["detail"])
            lines.append("")
        for h in c.get("history", []):
            lines.append(f"- {h['at'][:10]}: {h['status']}" + (f" - {h['note']}" if h.get("note") else ""))
    (ROOT / "CHANGES.md").write_text("\n".join(lines) + "\n")


def split_metric(spec, default=None):
    """'cost_per_turn=down' -> ('cost_per_turn', 'down')."""
    key, sep, d = spec.rpartition("=")
    if sep and d in ("up", "down"):
        return key, d
    return spec, default


def against_expectation(old, new, expect):
    if old is None or new is None or expect not in ("up", "down"):
        return ""
    if abs(new - old) <= 1e-9 or (old and abs(new - old) / abs(old) < 0.05):
        return "flat"
    return "as expected" if ((new > old) == (expect == "up")) else "opposite"


def changes_section(new_meta, new_dir):
    """Open changes, with each watched metric at its baseline and now."""
    items = [c for c in load_changes() if c["status"] in OPEN_STATUSES]
    if not items:
        return "No open changes. Log takeaways you act on with `usage_ledger.py change add`.\n"
    by_name = {d.name: m for d, m in reports()}
    out = []
    for c in items:
        out.append(f"### {c['id']} - {c['title']} ({c['status']})\n")
        base = by_name.get(c.get("baseline_report") or "")
        if c.get("baseline_report") == new_dir.name:
            out.append("Logged against this report - it is the baseline, judge it next time.\n")
            continue
        rows = []
        for spec in c.get("metrics") or []:
            k, exp = split_metric(spec, c.get("expect"))
            a = metric_value(base, k) if base else None
            b = metric_value(new_meta, k)
            if k.startswith("category_rate:"):
                label = f"$/hr: {k.split(':', 1)[1]}"
                fa = f"${a:.2f}" if a is not None else "-"
                fb = f"${b:.2f}" if b is not None else "-"
            elif k.startswith("model_share:"):
                label = "Share: " + k.split(":", 1)[1]
                fa = f"{a:.0%}" if a is not None else "-"
                fb = f"{b:.0%}" if b is not None else "-"
            else:
                label, fa, fb = METRICS[k][0], fmt(k, a), fmt(k, b)
            rows.append([label, fa, fb, exp or "-", against_expectation(a, b, exp)])
        if rows:
            out.append(table(["Metric", f"Baseline ({c.get('baseline_report')})", "Now", "Expected", "Result"], rows))
        out.append("\nVerdict: TODO - keep, revert, or give it another window? Then `change set " + c["id"] + " --status ...`.\n")
    return "\n".join(out) + "\n"


# ------------------------------------------------------------------ commands

def cmd_window(args):
    after, before, prev = next_window(args.after, args.before)
    print(json.dumps({"after": after, "before": before,
                      "previous_report": str(prev) if prev else None}, indent=2))


def cmd_run(args):
    after, before, _ = next_window(args.after, args.before)
    a_ms, b_ms = ps.parse_when(after), ps.parse_when(before)
    if a_ms is not None and b_ms <= a_ms:
        sys.exit(f"empty window: after {after} >= before {before}")

    out_dir = Path(args.dir).expanduser() if args.dir else ROOT / before[:10]
    if not args.dir and (out_dir / "metrics.json").exists():
        n = 2
        while (ROOT / f"{before[:10]}-{n}").exists():
            n += 1
        out_dir = ROOT / f"{before[:10]}-{n}"
    created = not out_dir.exists()
    data = out_dir / "data"
    data.mkdir(parents=True, exist_ok=True)

    cost = run_script(COST_SCRIPT, data / "cost.json", after, before, ["--no-per-session"])
    if not cost["meta"]["sessions_analyzed"]:
        if created:
            shutil.rmtree(out_dir)
        sys.exit(f"no activity between {after} and {before}; nothing to report")
    cost_sessions = run_script(COST_SCRIPT, data / "cost_sessions.json", after, before)
    run_script(INSIGHTS_SCRIPT, data / "sessions.json", after, before, ["--no-per-session"])
    exchanges = run_script(EXCHANGE_SCRIPT, data / "exchanges.json", after, before)
    if not args.no_content:
        run_script(CONTENT_SCRIPT, data / "content.json", after, before)

    by_sid = {s["session_id"]: s["cost_usd"] for s in cost_sessions.get("sessions", [])}
    act = activity(a_ms, b_ms, by_sid)
    (data / "activity.json").write_text(json.dumps(act, indent=2))
    (data / "activity.txt").write_text(activity_text(act))

    metrics, model_share = compute_metrics(cost, cost_sessions, exchanges, act, after, before)
    prev_dir, prev_meta = previous_report(before, out_dir)
    meta = {
        "generated_at": now_iso(),
        "window": {"after": after, "before": before},
        "first_activity": cost["meta"].get("first_activity"),
        "last_activity": cost["meta"].get("last_activity"),
        "previous_report": prev_dir.name if prev_dir and prev_meta else None,
        "metrics": metrics,
        "model_share": model_share,
    }
    old = out_dir / "metrics.json"
    if old.exists():  # keep categories from an earlier run over the same dir
        meta["categories"] = json.loads(old.read_text()).get("categories")
    old.write_text(json.dumps(meta, indent=2))

    report = out_dir / "report.md"
    if report.exists():
        skeleton_note = f"kept existing {report} (skeleton not written)"
    else:
        report.write_text(skeleton(meta, prev_meta, out_dir))
        skeleton_note = f"wrote skeleton {report}"
    print(json.dumps({
        "report_dir": str(out_dir),
        "window": meta["window"],
        "previous_report": meta["previous_report"],
        "report": skeleton_note,
        "read_next": [str(data / "cost.json"), str(data / "exchanges.json"),
                      str(data / "sessions.json"), str(data / "activity.txt")],
        "metrics": metrics,
    }, indent=2))


def skeleton(meta, prev_meta, out_dir):
    m = meta["metrics"]
    w = meta["window"]
    lines = [
        f"# pi usage report - {window_label(meta)}", "",
        f"Window: `{w.get('after') or 'beginning'}` to `{w['before']}` (entries after the first, up to the second).",
        f"Previous report: {meta['previous_report'] or 'none - this is the first'}.",
        "Raw data in `data/`; comparable metrics in `metrics.json`.", "",
        "## Headline", "",
        table(["Metric", "Value"], [[METRICS[k][0], fmt(k, m.get(k))] for k in METRICS]), "",
        "TODO: one paragraph - total, biggest line item, anything surprising.", "",
        "## Time and cost by category", "",
        CATEGORY_TODO, "",
        "## Compared to last report", "",
        (compare_table(prev_meta, meta) if prev_meta else "First report - nothing to compare yet."), "",
        "Window lengths differ, so compare the per-hour, per-turn and share rows, not raw totals.", "",
        "## Changes under evaluation", "",
        changes_section(meta, out_dir),
        "## Findings", "",
        "TODO", "",
        "## Takeaways", "",
        "TODO: what to change. Log each one you act on with `usage_ledger.py change add`.", "",
    ]
    return "\n".join(lines)


CATEGORY_TODO = ("TODO: sort `data/activity.txt` into categories, write a session_id -> category map,\n"
                 "and run `usage_ledger.py categorize --dir <this dir> --map map.json` to fill this table.")


def cmd_categorize(args):
    d = Path(args.dir).expanduser()
    meta = json.loads((d / "metrics.json").read_text())
    act = json.loads((d / "data" / "activity.json").read_text())
    mapping = json.loads(Path(args.map).expanduser().read_text())
    agg = collections.defaultdict(lambda: {"sessions": 0, "minutes": 0.0, "cost": 0.0})
    for r in act:
        # keys may be full ids or prefixes (activity.txt prints 13 chars); longest wins
        hits = [k for k in mapping if r["session_id"].startswith(k)]
        cat = mapping[max(hits, key=len)] if hits else args.default
        a = agg[cat]
        a["sessions"] += 1
        a["minutes"] += r["active_minutes"]
        a["cost"] += r["cost_usd"]
    tm = sum(a["minutes"] for a in agg.values()) or 1
    tc = sum(a["cost"] for a in agg.values()) or 1
    cats = {k: {"sessions": v["sessions"], "active_hours": round(v["minutes"] / 60, 2),
                "cost_usd": round(v["cost"], 2)} for k, v in agg.items()}
    meta["categories"] = cats
    (d / "metrics.json").write_text(json.dumps(meta, indent=2))
    rows = []
    for k, v in sorted(agg.items(), key=lambda kv: -kv[1]["cost"]):
        h = v["minutes"] / 60
        rows.append([k, v["sessions"], f"{h:.1f}h ({v['minutes'] / tm:.0%})",
                     f"${v['cost']:.2f}", f"{v['cost'] / tc:.0%}", f"${v['cost'] / h:.1f}" if h else "-"])
    text = table(["Category", "Sessions", "Active time", "Cost", "Cost share", "$/hr"], rows)
    (d / "data" / "categories.json").write_text(json.dumps(mapping, indent=2))
    report = d / "report.md"
    if report.exists() and CATEGORY_TODO in report.read_text():
        report.write_text(report.read_text().replace(CATEGORY_TODO, text))
        print(f"filled the category table in {report}")
    print(text)


def cmd_compare(args):
    rs = reports()
    if args.old and args.new:
        old = json.loads((Path(args.old).expanduser() / "metrics.json").read_text())
        new = json.loads((Path(args.new).expanduser() / "metrics.json").read_text())
    elif len(rs) >= 2:
        old, new = rs[-2][1], rs[-1][1]
    else:
        sys.exit("need two reports to compare")
    print(compare_table(old, new))


def cmd_change(args):
    items = load_changes()
    if args.action == "list":
        for c in items:
            if args.open and c["status"] not in OPEN_STATUSES:
                continue
            print(f"{c['id']}  {c['status']:<9} {c['title']}  [{', '.join(c.get('metrics') or [])}]")
        return
    if args.action == "add":
        if not args.title:
            sys.exit("change add needs --title")
        keys = [split_metric(m)[0] for m in args.metric or []]
        bad = [k for k in keys if k not in METRICS
               and not k.startswith(("model_share:", "category_rate:"))]
        if bad:
            sys.exit(f"unknown metric(s) {bad}; choose from {list(METRICS)}, "
                     "model_share:<provider/model>, or category_rate:<category> ($/active hour)")
        n = 1 + max((int(c["id"][1:]) for c in items), default=0)
        base_dir, _ = latest()
        c = {
            "id": f"C{n}", "title": args.title, "detail": args.detail,
            "metrics": args.metric or [], "expect": args.expect,
            "status": args.status or "proposed", "logged": now_iso(),
            "baseline_report": base_dir.name if base_dir else None,
            "history": [{"at": now_iso(), "status": args.status or "proposed", "note": args.note}],
        }
        items.append(c)
        save_changes(items)
        print(f"logged {c['id']} ({c['status']}) against baseline {c['baseline_report']}")
        return
    if args.action == "set":
        c = next((x for x in items if x["id"] == args.id), None)
        if not c:
            sys.exit(f"no change {args.id}")
        if args.status not in STATUSES:
            sys.exit(f"status must be one of {STATUSES}")
        if args.status == "applied" and c["status"] == "proposed":
            # The baseline for judging a change is the last report before it took effect.
            base_dir, _ = latest()
            c["baseline_report"] = base_dir.name if base_dir else c.get("baseline_report")
        c["status"] = args.status
        c["history"].append({"at": now_iso(), "status": args.status, "note": args.note})
        save_changes(items)
        print(f"{c['id']} -> {c['status']}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("window")
    p.add_argument("--after")
    p.add_argument("--before")
    p.set_defaults(fn=cmd_window)

    p = sub.add_parser("run")
    p.add_argument("--after", help="default: previous report's window end; 'none' = no lower bound")
    p.add_argument("--before", help="default: now")
    p.add_argument("--dir", help="report dir (default <root>/<before date>)")
    p.add_argument("--no-content", action="store_true", help="skip content_costs.py (slowest step)")
    p.set_defaults(fn=cmd_run)

    p = sub.add_parser("categorize")
    p.add_argument("--dir", required=True)
    p.add_argument("--map", required=True, help="JSON {session_id or prefix (as in activity.txt): category}")
    p.add_argument("--default", default="Other")
    p.set_defaults(fn=cmd_categorize)

    p = sub.add_parser("compare")
    p.add_argument("old", nargs="?")
    p.add_argument("new", nargs="?")
    p.set_defaults(fn=cmd_compare)

    p = sub.add_parser("change")
    p.add_argument("action", choices=["add", "set", "list"])
    p.add_argument("id", nargs="?")
    p.add_argument("--title")
    p.add_argument("--detail")
    p.add_argument("--metric", action="append", help="metric key to watch; repeatable")
    p.add_argument("--expect", choices=["up", "down"])
    p.add_argument("--status")
    p.add_argument("--note")
    p.add_argument("--open", action="store_true")
    p.set_defaults(fn=cmd_change)

    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
