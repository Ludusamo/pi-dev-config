#!/usr/bin/env python3
"""Price the *behavior* found by session-insights, using the cost data read by
cost-analysis. The join layer between the two skills.

session-insights answers "what do you keep doing?". cost-analysis answers
"where does the money go?". Neither answers "which of my habits is expensive?"
-- that needs both, and that is what this produces.

The unit of analysis is an **exchange**: one user message plus every assistant
turn and tool call it triggered, up to the next user message. Cost is summed
from provider-reported `usage.cost`, so exchange dollars are real charges.

Usage:
  exchange_costs.py [--scope all|project] [--cwd PATH] [--since DAYS]
                    [--limit N] [--top N] [--min-repeats N] [--out PATH]

Output sections:
  totals                  reconciliation against the raw spend
  repeated_request_costs  identical requests, clustered, with what they cost
  expensive_exchanges     the priciest individual requests
  error_costs             what exchanges containing failed tool calls cost
  tool_mix_costs          spend grouped by which tools an exchange used
  model_routing           per repeated cluster, which models ran it

IMPORTANT for interpretation: an exchange pays to re-send all context before
it, so later exchanges cost more regardless of what was asked. Every section
here reports `mean_position` (0 = session start, 1 = session end) so a claim
can be checked against it. A cluster that is expensive AND early is a real
finding; one that is expensive and always late may just be sitting downstream
of a long session.
"""
import argparse
import collections
import json
import os
import statistics
import sys
from pathlib import Path

_SHARED = Path(__file__).resolve().parent
sys.path.insert(0, str(_SHARED))
import pi_sessions as ps  # noqa: E402


def collect(scope, cwd, since, limit):
    """-> list of exchange dicts enriched with session identity and position."""
    rows = []
    for path in ps.iter_session_files(scope, cwd, since=since, limit=limit):
        header, entries = ps.read_session(path)
        if header is None:
            continue
        exchanges = ps.iter_exchanges(entries)
        n = len(exchanges)
        for ex in exchanges:
            ex["session_id"] = header.get("id")
            ex["cwd"] = header.get("cwd")
            ex["started"] = ps.iso(ex["user_ts"])
            # 0.0 = first exchange of the session, 1.0 = last
            ex["position"] = round(ex["index"] / (n - 1), 3) if n > 1 else 0.0
            ex["norm_hash"] = (
                ps.short_hash(ps.normalize_for_dedup(ex["user_text"]))
                if ex["user_text"] else None
            )
            rows.append(ex)
    return rows


def summarize(rows, top_n, min_repeats):
    total_cost = sum(r["cost"] for r in rows)
    total_turns = sum(r["assistant_turns"] for r in rows)

    # ---- repeated requests, priced ------------------------------------
    clusters = collections.defaultdict(list)
    for r in rows:
        if r["norm_hash"] and r["user_text"].strip():
            clusters[r["norm_hash"]].append(r)

    repeated = []
    for h, group in clusters.items():
        if len(group) < min_repeats:
            continue
        cost = sum(g["cost"] for g in group)
        repeated.append({
            "count": len(group),
            "example": ps.truncate(group[0]["user_text"], 200),
            "total_cost_usd": round(cost, 4),
            "avg_cost_usd": round(cost / len(group), 4),
            "share_of_spend": round(cost / total_cost, 4) if total_cost else 0.0,
            "assistant_turns": sum(g["assistant_turns"] for g in group),
            "sessions": sorted({g["session_id"] for g in group}),
            "projects": sorted({g["cwd"] for g in group if g["cwd"]}),
            "models": sorted({m for g in group for m in g["models"]}),
            "mean_position": round(statistics.fmean(g["position"] for g in group), 3),
            "tools": [t for t, _ in collections.Counter(
                t for g in group for t in g["tools"]).most_common(5)],
        })
    repeated.sort(key=lambda r: r["total_cost_usd"], reverse=True)

    # ---- expensive individual exchanges --------------------------------
    expensive = sorted(rows, key=lambda r: r["cost"], reverse=True)[:top_n]
    expensive_out = [{
        "session_id": r["session_id"],
        "cwd": r["cwd"],
        "started": r["started"],
        "position": r["position"],
        "cost_usd": round(r["cost"], 4),
        "assistant_turns": r["assistant_turns"],
        "request": ps.truncate(r["user_text"] or "[no user message]", 200),
        "tool_calls": len(r["tools"]),
        "tools": [t for t, _ in collections.Counter(r["tools"]).most_common(5)],
        "tool_errors": len(r["tool_errors"]),
        "models": r["models"],
    } for r in expensive]

    # ---- cost of exchanges that hit tool errors ------------------------
    err_rows = [r for r in rows if r["tool_errors"]]
    err_cost = sum(r["cost"] for r in err_rows)
    by_error = collections.defaultdict(lambda: {"count": 0, "cost": 0.0, "example": None})
    for r in err_rows:
        for e in r["tool_errors"]:
            key = f"{e['tool']}: {(e['error'] or '')[:80]}"
            b = by_error[key]
            b["count"] += 1
            # spread the exchange's cost across the errors it contained
            b["cost"] += r["cost"] / len(r["tool_errors"])
            b["example"] = b["example"] or ps.truncate(r["user_text"] or "", 120)

    error_costs = {
        "exchanges_with_errors": len(err_rows),
        "exchanges_total": len(rows),
        "cost_of_those_exchanges_usd": round(err_cost, 4),
        "share_of_spend": round(err_cost / total_cost, 4) if total_cost else 0.0,
        "largest_exchange_cost_usd": round(max((r["cost"] for r in err_rows), default=0.0), 4),
        "largest_exchange_share_of_error_cost": (
            round(max(r["cost"] for r in err_rows) / err_cost, 3) if err_cost else None),
        "note": (
            "This is the full cost of exchanges that contained a failed tool call, "
            "not the incremental cost of the failure itself. Read it as an upper "
            "bound on what fixing those failures could save. If "
            "largest_exchange_share_of_error_cost is high, one long exchange that "
            "merely happened to contain an error is carrying this number -- say so "
            "rather than reporting the headline share."
        ),
        "top_errors": sorted(
            ({"error": k, "occurrences": v["count"], "attributed_cost_usd": round(v["cost"], 4),
              "example_request": v["example"]} for k, v in by_error.items()),
            key=lambda r: r["attributed_cost_usd"], reverse=True)[:top_n],
    }

    # ---- spend by tool mix ---------------------------------------------
    tool_mix = collections.defaultdict(lambda: {"exchanges": 0, "cost": 0.0, "turns": 0})
    for r in rows:
        key = ",".join(sorted(set(r["tools"]))) or "(no tools)"
        t = tool_mix[key]
        t["exchanges"] += 1
        t["cost"] += r["cost"]
        t["turns"] += r["assistant_turns"]
    tool_mix_out = sorted(
        ({"tools": k, "exchanges": v["exchanges"], "assistant_turns": v["turns"],
          "cost_usd": round(v["cost"], 4),
          "avg_cost_per_exchange": round(v["cost"] / v["exchanges"], 4)}
         for k, v in tool_mix.items()),
        key=lambda r: r["cost_usd"], reverse=True)[:top_n]

    # ---- routing view: what each repeated cluster ran on -----------------
    routing = [{
        "example": r["example"],
        "count": r["count"],
        "total_cost_usd": r["total_cost_usd"],
        "models": r["models"],
        "already_partly_free": any(m.startswith("ollama/") for m in r["models"]),
    } for r in repeated[:top_n]]

    return {
        "meta": {
            "exchanges": len(rows),
            "sessions": len({r["session_id"] for r in rows}),
            "min_repeats": min_repeats,
        },
        "totals": {
            "cost_usd": round(total_cost, 4),
            "assistant_turns": total_turns,
            "avg_cost_per_exchange": round(total_cost / len(rows), 4) if rows else 0.0,
            "median_cost_per_exchange": round(
                statistics.median([r["cost"] for r in rows]), 4) if rows else 0.0,
        },
        "repeated_request_costs": repeated[:top_n],
        "expensive_exchanges": expensive_out,
        "error_costs": error_costs,
        "tool_mix_costs": tool_mix_out,
        "model_routing": routing,
    }


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scope", choices=["project", "all"], default="all")
    ap.add_argument("--cwd", default=os.getcwd())
    ap.add_argument("--since", type=float)
    ap.add_argument("--limit", type=int)
    ap.add_argument("--top", type=int, default=15)
    ap.add_argument("--min-repeats", type=int, default=2)
    ap.add_argument("--out")
    args = ap.parse_args()

    rows = collect(args.scope, args.cwd, args.since, args.limit)
    report = summarize(rows, args.top, args.min_repeats)
    text = json.dumps(report, indent=2)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
        print(f"wrote {args.out} ({report['meta']['exchanges']} exchanges, "
              f"${report['totals']['cost_usd']:.4f} attributed)")
    else:
        print(text)


if __name__ == "__main__":
    main()
