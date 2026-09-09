#!/usr/bin/env python3
"""
Extract spend/token accounting from pi.dev session JSONL files.

Usage:
  extract_costs.py [options]

Options:
  --scope {project,all}   "all" = every session directory (default),
                          "project" = sessions for a given cwd only
  --cwd PATH              Project directory to match (default: current working dir).
                          Only used when --scope=project.
  --since DAYS            Only include sessions whose last activity is within DAYS days.
  --limit N               Only include the N most recent session files.
  --top N                 How many rows to keep in "top N" style lists (default 15).
  --reprice MODELS        Comma-separated model ids/patterns to reprice the observed
                          token profile against (default: auto-pick from the catalog).
  --catalog PATH          Model price catalog (default ~/.pi/agent/models-store.json).
  --no-per-session        Omit the per-session array (much smaller output).
  --no-turn-series        Omit per-turn series inside each session (smaller output).
  --out PATH              Write JSON report to PATH instead of stdout.

Cost accounting notes:
  * pi records real, provider-reported cost on every assistant message under
    message.usage.cost -> {input, output, cacheRead, cacheWrite, total} in USD.
    Those numbers are authoritative; this script sums them, it does not re-derive them.
  * Catalog prices (models-store.json) are USD per 1M tokens and are only used
    for counterfactual repricing and for estimating cache carry cost.
  * Local/free providers (e.g. ollama) report zero cost; they are tracked
    separately as "free turns" so they don't dilute paid averages.

This script performs NO interpretation -- it only extracts, sums, and ranks.
All qualitative analysis belongs to the calling agent (see references/).
"""
import argparse
import collections
import datetime as dt
import json
import os
import statistics
import sys
from pathlib import Path

# Shared session parsing lives with the skills, not in any project repo:
# skills/shared/pi_sessions.py (installed at ~/.pi/agent/skills/shared/).
_SHARED = Path(__file__).resolve().parents[2] / "shared"
if not _SHARED.exists():
    _SHARED = Path.home() / ".pi" / "agent" / "skills" / "shared"
sys.path.insert(0, str(_SHARED))
import pi_sessions as ps  # noqa: E402

SESSIONS_ROOT = ps.SESSIONS_ROOT
cwd_to_dirname = ps.cwd_to_dirname
iter_session_files = ps.iter_session_files
DEFAULT_CATALOG = ps.MODELS_STORE

# Token components that carry a price, in the order we report them.
COMPONENTS = ps.COST_COMPONENTS
TOKEN_FIELDS = ps.TOKEN_FIELDS
CHARS_PER_TOKEN = 4.0  # rough estimate, only used for tool-output attribution

to_epoch_ms = ps.to_epoch_ms
iso = ps.iso
text_len = ps.text_len
load_catalog = ps.load_catalog
price_for = ps.price_for
reprice = ps.reprice


# --------------------------------------------------------------------------
# per-session extraction
# --------------------------------------------------------------------------

def extract_session(path: Path, keep_turn_series: bool):
    header, entries = ps.read_session(path)
    if header is None:
        return None

    # Positions of assistant turns, so a tool result can be charged for the
    # turns that still have to carry it in context.
    assistant_positions = [
        i for i, e in enumerate(entries)
        if e.get("type") == "message" and (e.get("message") or {}).get("role") == "assistant"
    ]
    total_turns = len(assistant_positions)

    tokens = collections.Counter()
    cost_by_component = collections.Counter()
    cost_total = 0.0
    per_model = collections.defaultdict(lambda: {
        "turns": 0, "cost": 0.0, "tokens": collections.Counter(),
        "cost_by_component": collections.Counter(),
    })
    turn_series, turn_costs, tool_results = [], [], []
    stop_reasons = collections.Counter()
    model_changes, compactions = 0, 0
    free_turns = paid_turns = 0
    start_ms = to_epoch_ms(header.get("timestamp"))
    end_ms = start_ms
    turn_idx = 0

    for pos, entry in enumerate(entries):
        etype = entry.get("type")
        ms = to_epoch_ms(entry.get("timestamp"))
        if ms:
            end_ms = ms if end_ms is None else max(end_ms, ms)
            start_ms = ms if start_ms is None else min(start_ms, ms)
        if etype == "model_change":
            model_changes += 1
            continue
        if etype in ("compaction", "compact", "branch_summary"):
            compactions += 1
            continue
        if etype != "message":
            continue

        msg = entry.get("message") or {}
        role = msg.get("role")

        if role == "toolResult":
            chars = text_len(msg.get("content"))
            tool_results.append({
                "tool": msg.get("toolName") or "unknown",
                "chars": chars,
                "est_tokens": round(chars / CHARS_PER_TOKEN),
                # how many assistant turns still had to re-send this in context
                "carried_turns": sum(1 for p in assistant_positions if p > pos),
                "isError": bool(msg.get("isError")),
                "timestamp": iso(ms),
            })
            continue

        if role != "assistant":
            continue

        turn_idx += 1
        usage = msg.get("usage") or {}
        cost = usage.get("cost") or {}
        model = msg.get("model") or "unknown"
        provider = msg.get("provider") or "unknown"
        key = f"{provider}/{model}"
        stop_reasons[msg.get("stopReason") or "unknown"] += 1

        turn_tokens = {k: int(usage.get(k) or 0) for k in TOKEN_FIELDS}
        turn_cost = float(cost.get("total") or 0.0)
        cost_total += turn_cost
        if turn_cost > 0:
            paid_turns += 1
        else:
            free_turns += 1
        for k, v in turn_tokens.items():
            tokens[k] += v
        for k in COMPONENTS:
            cost_by_component[k] += float(cost.get(k) or 0.0)

        pm = per_model[key]
        pm["turns"] += 1
        pm["cost"] += turn_cost
        for k, v in turn_tokens.items():
            pm["tokens"][k] += v
        for k in COMPONENTS:
            pm["cost_by_component"][k] += float(cost.get(k) or 0.0)

        turn_costs.append(turn_cost)
        # Context actually paid for on this turn: fresh input + cache reads + cache writes.
        context_tokens = turn_tokens["input"] + turn_tokens["cacheRead"] + turn_tokens["cacheWrite"]
        if keep_turn_series:
            turn_series.append({
                "turn": turn_idx,
                "timestamp": iso(ms),
                "model": key,
                "context_tokens": context_tokens,
                "output": turn_tokens["output"],
                "reasoning": turn_tokens["reasoning"],
                "cost": round(turn_cost, 6),
            })

    duration_s = round((end_ms - start_ms) / 1000, 1) if (start_ms and end_ms) else None
    cache_read = tokens["cacheRead"]
    cache_write = tokens["cacheWrite"]
    fresh = tokens["input"] + cache_read + cache_write

    out = {
        "file": str(path),
        "session_id": header.get("id"),
        "cwd": header.get("cwd"),
        "started": iso(start_ms),
        "ended": iso(end_ms),
        "duration_seconds": duration_s,
        "turns": total_turns,
        "paid_turns": paid_turns,
        "free_turns": free_turns,
        "model_changes": model_changes,
        "compactions": compactions,
        "stop_reasons": dict(stop_reasons),
        "cost_usd": round(cost_total, 6),
        "cost_by_component": {k: round(v, 6) for k, v in cost_by_component.items()},
        "tokens": dict(tokens),
        "cost_per_turn": {
            "mean": round(statistics.fmean(turn_costs), 6) if turn_costs else 0.0,
            "median": round(statistics.median(turn_costs), 6) if turn_costs else 0.0,
            "max": round(max(turn_costs), 6) if turn_costs else 0.0,
        },
        "cache": {
            "read_share_of_context": round(cache_read / fresh, 4) if fresh else None,
            # >1 means each written token was read back more than once (write premium repaid)
            "write_amortization": round(cache_read / cache_write, 2) if cache_write else None,
        },
        "per_model": {
            k: {
                "turns": v["turns"],
                "cost_usd": round(v["cost"], 6),
                "tokens": dict(v["tokens"]),
                "cost_by_component": {c: round(x, 6) for c, x in v["cost_by_component"].items()},
            }
            for k, v in per_model.items()
        },
        "_tool_results": tool_results,  # consumed by the aggregator, stripped afterwards
    }
    if keep_turn_series:
        out["turn_series"] = turn_series
        if turn_series:
            first_q = turn_series[: max(1, len(turn_series) // 4)]
            last_q = turn_series[-max(1, len(turn_series) // 4):]
            out["context_growth"] = {
                "first_turn_context_tokens": turn_series[0]["context_tokens"],
                "last_turn_context_tokens": turn_series[-1]["context_tokens"],
                "peak_context_tokens": max(t["context_tokens"] for t in turn_series),
                "mean_cost_first_quarter": round(statistics.fmean(t["cost"] for t in first_q), 6),
                "mean_cost_last_quarter": round(statistics.fmean(t["cost"] for t in last_q), 6),
            }
    return out


# --------------------------------------------------------------------------
# aggregation
# --------------------------------------------------------------------------

def build_report(sessions, prices, by_id, top_n, reprice_patterns):
    totals_tokens = collections.Counter()
    totals_component = collections.Counter()
    total_cost = 0.0
    paid_turns = free_turns = total_turns = 0
    by_model = collections.defaultdict(lambda: {
        "turns": 0, "cost": 0.0, "sessions": 0,
        "tokens": collections.Counter(), "cost_by_component": collections.Counter(),
        "turn_costs": [],
    })
    by_project = collections.defaultdict(lambda: {"sessions": 0, "turns": 0, "cost": 0.0, "tokens": collections.Counter(), "models": collections.Counter()})
    by_day = collections.defaultdict(lambda: {"cost": 0.0, "turns": 0, "tokens": collections.Counter(), "sessions": set()})
    tool_attr = collections.defaultdict(lambda: {"results": 0, "chars": 0, "est_tokens": 0, "carry_tokens": 0, "errors": 0})
    first_ms = last_ms = None

    for s in sessions:
        total_cost += s["cost_usd"]
        total_turns += s["turns"]
        paid_turns += s["paid_turns"]
        free_turns += s["free_turns"]
        totals_tokens.update(s["tokens"])
        totals_component.update(s["cost_by_component"])

        for key, pm in s["per_model"].items():
            b = by_model[key]
            b["turns"] += pm["turns"]
            b["cost"] += pm["cost_usd"]
            b["sessions"] += 1
            b["tokens"].update(pm["tokens"])
            b["cost_by_component"].update(pm["cost_by_component"])

        proj = by_project[s["cwd"] or "unknown"]
        proj["sessions"] += 1
        proj["turns"] += s["turns"]
        proj["cost"] += s["cost_usd"]
        proj["tokens"].update(s["tokens"])
        for key, pm in s["per_model"].items():
            proj["models"][key] += pm["turns"]

        day = (s["started"] or "")[:10] or "unknown"
        d = by_day[day]
        d["cost"] += s["cost_usd"]
        d["turns"] += s["turns"]
        d["tokens"].update(s["tokens"])
        d["sessions"].add(s["session_id"])

        # Tool-output carry cost: a big tool result is re-sent (as cache reads)
        # on every later turn of the session. Price it with this session's
        # dominant model's cacheRead rate.
        dominant = max(s["per_model"].items(), key=lambda kv: kv[1]["cost_usd"], default=(None, None))[0]
        cache_rate = 0.0
        if dominant:
            prov, _, mid = dominant.partition("/")
            p = price_for(prices, by_id, prov, mid)
            cache_rate = (p or {}).get("cacheRead", 0.0)
        for tr in s.get("_tool_results", []):
            a = tool_attr[tr["tool"]]
            a["results"] += 1
            a["chars"] += tr["chars"]
            a["est_tokens"] += tr["est_tokens"]
            a["carry_tokens"] += tr["est_tokens"] * tr["carried_turns"]
            a["errors"] += 1 if tr["isError"] else 0
            a.setdefault("_rate", cache_rate)
            a["_rate"] = max(a["_rate"], cache_rate)

        for stamp in (s["started"], s["ended"]):
            if not stamp:
                continue
            first_ms = stamp if first_ms is None else min(first_ms, stamp)
            last_ms = stamp if last_ms is None else max(last_ms, stamp)

    def model_row(key, b):
        toks = b["tokens"]
        billable = sum(toks.get(k, 0) for k in COMPONENTS)
        prov, _, mid = key.partition("/")
        p = price_for(prices, by_id, prov, mid)
        return {
            "model": key,
            "turns": b["turns"],
            "sessions": b["sessions"],
            "cost_usd": round(b["cost"], 6),
            "share_of_spend": round(b["cost"] / total_cost, 4) if total_cost else 0.0,
            "tokens": dict(toks),
            "cost_by_component": {k: round(v, 6) for k, v in b["cost_by_component"].items()},
            "avg_cost_per_turn": round(b["cost"] / b["turns"], 6) if b["turns"] else 0.0,
            "effective_usd_per_mtok": round(b["cost"] / billable * 1e6, 4) if billable else 0.0,
            "catalog_price_per_mtok": {k: p[k] for k in COMPONENTS} if p else None,
        }

    models = sorted((model_row(k, v) for k, v in by_model.items()),
                    key=lambda r: r["cost_usd"], reverse=True)

    tools = []
    for name, a in tool_attr.items():
        rate = a.get("_rate", 0.0)
        tools.append({
            "tool": name,
            "results": a["results"],
            "error_results": a["errors"],
            "total_result_chars": a["chars"],
            "est_result_tokens": a["est_tokens"],
            "avg_result_tokens": round(a["est_tokens"] / a["results"]) if a["results"] else 0,
            # tokens re-sent as context on later turns because of this tool
            "est_carried_tokens": a["carry_tokens"],
            "est_carry_cost_usd": round(a["carry_tokens"] * rate / 1e6, 4),
        })
    tools.sort(key=lambda r: r["est_carry_cost_usd"], reverse=True)

    all_billable = sum(totals_tokens.get(k, 0) for k in COMPONENTS)
    cache_read = totals_tokens.get("cacheRead", 0)
    cache_write = totals_tokens.get("cacheWrite", 0)

    report = {
        "meta": {
            "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "sessions_analyzed": len(sessions),
            "first_activity": first_ms,
            "last_activity": last_ms,
            "catalog_models_priced": len(prices),
        },
        "totals": {
            "cost_usd": round(total_cost, 4),
            "turns": total_turns,
            "paid_turns": paid_turns,
            "free_turns": free_turns,
            "tokens": dict(totals_tokens),
            "cost_by_component": {k: round(v, 6) for k, v in totals_component.items()},
            "cost_share_by_component": {
                k: round(v / total_cost, 4) for k, v in totals_component.items()
            } if total_cost else {},
            "avg_cost_per_paid_turn": round(total_cost / paid_turns, 6) if paid_turns else 0.0,
            "avg_cost_per_session": round(total_cost / len(sessions), 4) if sessions else 0.0,
            "blended_usd_per_mtok": round(total_cost / all_billable * 1e6, 4) if all_billable else 0.0,
            "cache": {
                "read_share_of_context": round(cache_read / all_billable, 4) if all_billable else None,
                "write_amortization": round(cache_read / cache_write, 2) if cache_write else None,
            },
        },
        "by_model": models,
        "by_project": sorted(
            ({
                "cwd": k,
                "sessions": v["sessions"],
                "turns": v["turns"],
                "cost_usd": round(v["cost"], 4),
                "tokens_total": v["tokens"].get("totalTokens", 0),
                "cost_per_session": round(v["cost"] / v["sessions"], 4) if v["sessions"] else 0.0,
                "models": dict(v["models"]),
            } for k, v in by_project.items()),
            key=lambda r: r["cost_usd"], reverse=True),
        "by_day": sorted(
            ({
                "date": k,
                "cost_usd": round(v["cost"], 4),
                "sessions": len(v["sessions"]),
                "turns": v["turns"],
                "tokens_total": v["tokens"].get("totalTokens", 0),
            } for k, v in by_day.items()),
            key=lambda r: r["date"]),
        "most_expensive_sessions": sorted(
            ({
                "session_id": s["session_id"],
                "cwd": s["cwd"],
                "started": s["started"],
                "cost_usd": s["cost_usd"],
                "turns": s["turns"],
                "duration_seconds": s["duration_seconds"],
                "models": list(s["per_model"].keys()),
                "peak_context_tokens": (s.get("context_growth") or {}).get("peak_context_tokens"),
                "cache_write_amortization": s["cache"]["write_amortization"],
            } for s in sessions),
            key=lambda r: r["cost_usd"], reverse=True)[:top_n],
        "tool_output_cost_attribution": tools[:top_n],
    }

    report["repricing"] = build_repricing(models, prices, by_id, total_cost, reprice_patterns, top_n)
    return report


def build_repricing(models, prices, by_id, total_cost, patterns, top_n):
    """What the SAME token profile would have cost on other models."""
    profile = collections.Counter()
    for row in models:
        if row["cost_usd"] <= 0:
            continue  # free/local turns carry no comparable profile
        for k in COMPONENTS:
            profile[k] += row["tokens"].get(k, 0)
    if not profile:
        return {"note": "no paid turns to reprice"}

    candidates = []
    for (provider, mid), p in prices.items():
        if patterns and not any(pat.lower() in f"{provider}/{mid}".lower() for pat in patterns):
            continue
        if not any(p.get(k) for k in COMPONENTS):
            continue
        c = reprice(profile, p)
        candidates.append({
            "model": f"{provider}/{mid}",
            "cost_usd": round(c, 4),
            "delta_usd": round(c - total_cost, 4),
            "delta_pct": round((c - total_cost) / total_cost * 100, 1) if total_cost else None,
            "price_per_mtok": {k: p[k] for k in COMPONENTS},
            "context_window": p.get("contextWindow"),
        })
    candidates.sort(key=lambda r: r["cost_usd"])
    return {
        "paid_token_profile": dict(profile),
        "actual_cost_usd": round(total_cost, 4),
        "caveat": (
            "Same-token-profile repricing only. A cheaper model that needs more turns, "
            "more retries, or larger prompts can cost MORE in practice. Treat as an "
            "upper bound on savings, not a forecast."
        ),
        "candidates": candidates[:top_n] + [c for c in candidates[-3:] if c not in candidates[:top_n]],
    }


# --------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Extract pi.dev session cost accounting.")
    ap.add_argument("--scope", choices=["project", "all"], default="all")
    ap.add_argument("--cwd", default=os.getcwd())
    ap.add_argument("--since", type=float)
    ap.add_argument("--limit", type=int)
    ap.add_argument("--top", type=int, default=15)
    ap.add_argument("--reprice", default="")
    ap.add_argument("--catalog", default=str(DEFAULT_CATALOG))
    ap.add_argument("--no-per-session", action="store_true")
    ap.add_argument("--no-turn-series", action="store_true")
    ap.add_argument("--out")
    args = ap.parse_args()

    files = iter_session_files(args.scope, args.cwd)
    if args.since:
        cutoff = dt.datetime.now().timestamp() - args.since * 86400
        files = [f for f in files if f.stat().st_mtime >= cutoff]
    files = sorted(files, key=lambda f: f.stat().st_mtime)
    if args.limit:
        files = files[-args.limit:]

    prices, by_id = load_catalog(Path(args.catalog))
    sessions = []
    for f in files:
        s = extract_session(f, keep_turn_series=not args.no_turn_series)
        if s:
            sessions.append(s)

    patterns = [p.strip() for p in args.reprice.split(",") if p.strip()]
    report = build_report(sessions, prices, by_id, args.top, patterns)

    for s in sessions:
        s.pop("_tool_results", None)
    if not args.no_per_session:
        report["sessions"] = sorted(sessions, key=lambda s: s["started"] or "")

    text = json.dumps(report, indent=2)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
        print(f"wrote {args.out} ({len(text)} bytes, {len(sessions)} sessions, "
              f"${report['totals']['cost_usd']:.4f} total)")
    else:
        print(text)


if __name__ == "__main__":
    main()
