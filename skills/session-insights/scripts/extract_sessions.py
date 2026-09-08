#!/usr/bin/env python3
"""
Extract structured, LLM-friendly summaries from pi.dev session JSONL files.

Usage:
  extract_sessions.py [options]

Options:
  --scope {project,all}   "project" = sessions for a given cwd only (default),
                          "all" = every session directory under ~/.pi/agent/sessions
  --cwd PATH              Project directory to match (default: current working dir).
                          Only used when --scope=project.
  --since DAYS            Only include sessions modified in the last DAYS days.
  --limit N               Only include the N most recent session files.
  --max-text-len N        Truncate long text fields to N chars (default 400).
  --out PATH              Write JSON report to PATH instead of stdout.
  --no-per-session        Omit the detailed per-session array, aggregates only.

The output JSON has two top-level keys:
  "sessions"   -> list of per-session extracts (unless --no-per-session)
  "aggregate"  -> cross-session counts/patterns useful for trend analysis

This script performs NO interpretation -- it only extracts and counts.
All qualitative analysis (finding redundancy, recommending fixes, etc.)
should be done by the calling agent/LLM using this data as evidence.
"""
import argparse
import collections
import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path

SESSIONS_ROOT = Path.home() / ".pi" / "agent" / "sessions"


def cwd_to_dirname(cwd: str) -> str:
    # Mirrors pi's own scheme: "/" -> "-"
    return "--" + cwd.strip("/").replace("/", "-") + "--"


def iter_session_files(scope: str, cwd: str):
    if not SESSIONS_ROOT.exists():
        return []
    if scope == "all":
        return sorted(SESSIONS_ROOT.glob("*/*.jsonl"))
    target_dir = SESSIONS_ROOT / cwd_to_dirname(cwd)
    if not target_dir.exists():
        return []
    return sorted(target_dir.glob("*.jsonl"))


def truncate(s, n):
    if s is None:
        return s
    if len(s) <= n:
        return s
    return s[:n] + f"... [truncated, {len(s)} chars total]"


def text_of(content):
    """Flatten UserMessage/AssistantMessage content (str or content-block list) to plain text."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if not isinstance(block, dict):
                continue
            t = block.get("type")
            if t == "text":
                parts.append(block.get("text", ""))
            elif t == "thinking":
                pass  # skip thinking content, not user-facing
            elif t == "image":
                parts.append("[image]")
        return "\n".join(p for p in parts if p)
    return ""


def normalize_for_dedup(s: str) -> str:
    s = s.lower().strip()
    s = re.sub(r"\s+", " ", s)
    s = re.sub(r"[^\w\s]", "", s)
    return s


def short_hash(s: str) -> str:
    return hashlib.sha1(s.encode("utf-8", "ignore")).hexdigest()[:10]


def summarize_tool_args(name, args):
    """Extract a compact, comparable signature for a tool call."""
    if not isinstance(args, dict):
        return {}
    out = {}
    if name == "bash" or name == "Bash":
        cmd = args.get("command", "")
        out["command"] = truncate(cmd, 200)
        # first token = the actual program invoked
        toks = cmd.strip().split()
        out["program"] = toks[0] if toks else ""
    elif name in ("read", "Read"):
        out["path"] = args.get("path")
    elif name in ("edit", "Edit"):
        out["path"] = args.get("path")
        edits = args.get("edits") or []
        out["num_edits"] = len(edits) if isinstance(edits, list) else None
    elif name in ("write", "Write"):
        out["path"] = args.get("path")
    else:
        # generic: keep small scalar args only
        for k, v in args.items():
            if isinstance(v, (str, int, float, bool)) and len(str(v)) < 200:
                out[k] = v
    return out


def extract_session(path: Path, max_text_len: int):
    entries = []
    header = None
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if entry.get("type") == "session":
                header = entry
                continue
            entries.append(entry)

    if header is None:
        return None

    user_messages = []
    assistant_texts = []
    tool_calls = []
    tool_errors = []
    bash_commands = []
    files_read, files_written, files_edited = set(), set(), set()
    models_used = collections.Counter()
    stop_reasons = collections.Counter()
    usage_totals = collections.defaultdict(float)
    compactions = 0
    branch_summaries = 0
    n_messages = 0
    start_ts, end_ts = None, None

    for entry in entries:
        ts = entry.get("timestamp")
        if ts:
            if start_ts is None:
                start_ts = ts
            end_ts = ts

        etype = entry.get("type")
        if etype == "model_change":
            models_used[f"{entry.get('provider')}/{entry.get('modelId')}"] += 1
            continue
        if etype == "compaction":
            compactions += 1
            continue
        if etype == "branch_summary":
            branch_summaries += 1
            continue
        if etype != "message":
            continue

        msg = entry.get("message", {})
        role = msg.get("role")
        n_messages += 1

        if role == "user":
            txt = text_of(msg.get("content"))
            if txt.strip():
                user_messages.append({
                    "id": entry.get("id"),
                    "timestamp": ts,
                    "text": truncate(txt, max_text_len),
                    "norm_hash": short_hash(normalize_for_dedup(txt))[:10] if txt.strip() else None,
                })

        elif role == "assistant":
            content = msg.get("content") or []
            texts = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
            joined = "\n".join(t for t in texts if t)
            if joined.strip():
                assistant_texts.append(truncate(joined, max_text_len))
            for b in content:
                if isinstance(b, dict) and b.get("type") == "toolCall":
                    name = b.get("name")
                    args = b.get("arguments") or {}
                    sig = summarize_tool_args(name, args)
                    tool_calls.append({"name": name, **sig})
                    if name in ("bash", "Bash") and "command" in sig:
                        bash_commands.append(sig["command"])
                    if name in ("read", "Read") and sig.get("path"):
                        files_read.add(sig["path"])
                    if name in ("write", "Write") and sig.get("path"):
                        files_written.add(sig["path"])
                    if name in ("edit", "Edit") and sig.get("path"):
                        files_edited.add(sig["path"])
            sr = msg.get("stopReason")
            if sr:
                stop_reasons[sr] += 1
            usage = msg.get("usage") or {}
            for k in ("input", "output", "cacheRead", "cacheWrite", "totalTokens"):
                v = usage.get(k)
                if isinstance(v, (int, float)):
                    usage_totals[k] += v
            cost = usage.get("cost") or {}
            tot_cost = cost.get("total")
            if isinstance(tot_cost, (int, float)):
                usage_totals["cost_total"] += tot_cost

        elif role == "toolResult":
            if msg.get("isError"):
                txt = text_of(msg.get("content"))
                tool_errors.append({
                    "toolName": msg.get("toolName"),
                    "error": truncate(txt, 200),
                })

        elif role == "bashExecution":
            cmd = msg.get("command", "")
            bash_commands.append(cmd)
            if msg.get("exitCode") not in (0, None):
                tool_errors.append({"toolName": "bash", "error": f"exit {msg.get('exitCode')}: {truncate(cmd, 100)}"})

    duration_s = None
    try:
        from datetime import datetime
        if start_ts and end_ts:
            t0 = datetime.fromisoformat(start_ts.replace("Z", "+00:00"))
            t1 = datetime.fromisoformat(end_ts.replace("Z", "+00:00"))
            duration_s = (t1 - t0).total_seconds()
    except Exception:
        pass

    tool_name_counts = collections.Counter(tc["name"] for tc in tool_calls)

    return {
        "file": str(path),
        "session_id": header.get("id"),
        "cwd": header.get("cwd"),
        "started": start_ts,
        "ended": end_ts,
        "duration_seconds": duration_s,
        "message_count": n_messages,
        "models_used": dict(models_used),
        "stop_reasons": dict(stop_reasons),
        "compactions": compactions,
        "branch_summaries": branch_summaries,
        "usage_totals": dict(usage_totals),
        "tool_call_counts": dict(tool_name_counts),
        "bash_commands": bash_commands,
        "files_read": sorted(files_read),
        "files_written": sorted(files_written),
        "files_edited": sorted(files_edited),
        "tool_errors": tool_errors,
        "user_messages": user_messages,
        "assistant_text_samples": assistant_texts[:20],  # cap volume
    }


def build_aggregate(sessions):
    tool_counter = collections.Counter()
    program_counter = collections.Counter()
    file_read_counter = collections.Counter()
    file_write_counter = collections.Counter()
    file_edit_counter = collections.Counter()
    model_counter = collections.Counter()
    error_counter = collections.Counter()
    user_msg_hash_groups = collections.defaultdict(list)  # norm_hash -> [ (session_file, text) ]
    bash_cmd_counter = collections.Counter()
    total_cost = 0.0
    total_tokens = 0.0
    total_sessions = len(sessions)
    total_duration = 0.0

    for s in sessions:
        for name, cnt in s["tool_call_counts"].items():
            tool_counter[name] += cnt
        for cmd in s["bash_commands"]:
            bash_cmd_counter[cmd] += 1
            prog = cmd.strip().split()[0] if cmd.strip() else ""
            if prog:
                program_counter[prog] += 1
        for f in s["files_read"]:
            file_read_counter[f] += 1
        for f in s["files_written"]:
            file_write_counter[f] += 1
        for f in s["files_edited"]:
            file_edit_counter[f] += 1
        for m, cnt in s["models_used"].items():
            model_counter[m] += cnt
        for e in s["tool_errors"]:
            key = f"{e.get('toolName')}: {e.get('error','')[:80]}"
            error_counter[key] += 1
        for um in s["user_messages"]:
            h = um.get("norm_hash")
            if h:
                user_msg_hash_groups[h].append({"file": s["file"], "text": um["text"]})
        total_cost += s["usage_totals"].get("cost_total", 0.0)
        total_tokens += s["usage_totals"].get("totalTokens", 0.0)
        if s.get("duration_seconds"):
            total_duration += s["duration_seconds"]

    # Repeated near-identical user requests across sessions (exact-normalized dupes)
    repeated_requests = [
        {"count": len(v), "example": v[0]["text"], "sessions": sorted({x["file"] for x in v})}
        for h, v in user_msg_hash_groups.items() if len(v) > 1
    ]
    repeated_requests.sort(key=lambda r: -r["count"])

    return {
        "total_sessions": total_sessions,
        "total_cost_usd": round(total_cost, 4),
        "total_tokens": total_tokens,
        "total_duration_hours": round(total_duration / 3600, 2) if total_duration else None,
        "tool_usage_counts": dict(tool_counter.most_common()),
        "top_bash_programs": dict(program_counter.most_common(30)),
        "top_bash_commands_verbatim": dict(bash_cmd_counter.most_common(30)),
        "most_read_files": dict(file_read_counter.most_common(30)),
        "most_written_files": dict(file_write_counter.most_common(30)),
        "most_edited_files": dict(file_edit_counter.most_common(30)),
        "models_used": dict(model_counter.most_common()),
        "common_errors": dict(error_counter.most_common(30)),
        "exact_repeated_user_requests": repeated_requests[:50],
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scope", choices=["project", "all"], default="project")
    ap.add_argument("--cwd", default=os.getcwd())
    ap.add_argument("--since", type=float, default=None, help="only sessions modified in last N days")
    ap.add_argument("--limit", type=int, default=None, help="only N most recent session files")
    ap.add_argument("--max-text-len", type=int, default=400)
    ap.add_argument("--out", default=None)
    ap.add_argument("--no-per-session", action="store_true")
    args = ap.parse_args()

    files = list(iter_session_files(args.scope, args.cwd))

    if args.since is not None:
        cutoff = time.time() - args.since * 86400
        files = [f for f in files if f.stat().st_mtime >= cutoff]

    files.sort(key=lambda f: f.stat().st_mtime)
    if args.limit:
        files = files[-args.limit:]

    sessions = []
    for f in files:
        try:
            s = extract_session(f, args.max_text_len)
            if s:
                sessions.append(s)
        except Exception as e:
            print(f"warning: failed to parse {f}: {e}", file=sys.stderr)

    aggregate = build_aggregate(sessions)
    report = {"aggregate": aggregate}
    if not args.no_per_session:
        report["sessions"] = sessions

    out_json = json.dumps(report, indent=2, default=str)
    if args.out:
        Path(args.out).write_text(out_json)
        print(f"Wrote report to {args.out} ({len(files)} session files, {aggregate['total_sessions']} parsed)", file=sys.stderr)
    else:
        print(out_json)


if __name__ == "__main__":
    main()
