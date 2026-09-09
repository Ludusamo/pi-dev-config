#!/usr/bin/env python3
"""Shared pi.dev session-log parsing for the session-insights and cost-analysis skills.

One place that knows the shape of a session JSONL file, so the behavioral
analyzer and the cost analyzer can't drift apart on details like how a cwd
maps to a directory name, or whether a timestamp is ISO or epoch millis.

This module holds parsing primitives only -- no counting, no interpretation.

Log shape (one JSON object per line):
  {"type":"session", "id":..., "cwd":..., "timestamp":"<ISO>"}      first line
  {"type":"message", "message":{...}, "timestamp":<epoch ms>, ...}
  {"type":"model_change"|"thinking_level_change"|..., ...}

message.role is one of: user | assistant | toolResult | bashExecution.
Assistant messages carry `usage` with provider-reported `cost` in USD.
"""
import hashlib
import json
import re
import time
import datetime as dt
from pathlib import Path

SESSIONS_ROOT = Path.home() / ".pi" / "agent" / "sessions"
MODELS_STORE = Path.home() / ".pi" / "agent" / "models-store.json"

# Token components that carry a price.
COST_COMPONENTS = ("input", "output", "cacheRead", "cacheWrite")
TOKEN_FIELDS = COST_COMPONENTS + ("cacheWrite1h", "reasoning", "totalTokens")


# ---------------------------------------------------------------- discovery

def cwd_to_dirname(cwd: str) -> str:
    """Mirrors pi's own scheme: "/" -> "-", wrapped in double dashes."""
    return "--" + cwd.strip("/").replace("/", "-") + "--"


def iter_session_files(scope: str, cwd: str, since=None, limit=None, root: Path = None):
    """Session files for a scope, oldest-modified first.

    scope="all" spans every project; scope="project" matches one cwd.
    since = only files modified within N days; limit = keep N most recent.
    """
    root = root or SESSIONS_ROOT
    if not root.exists():
        return []
    if scope == "all":
        files = list(root.glob("*/*.jsonl"))
    else:
        target = root / cwd_to_dirname(cwd)
        files = list(target.glob("*.jsonl")) if target.exists() else []
    if since is not None:
        cutoff = time.time() - since * 86400
        files = [f for f in files if f.stat().st_mtime >= cutoff]
    files.sort(key=lambda f: f.stat().st_mtime)
    if limit:
        files = files[-limit:]
    return files


# ------------------------------------------------------------------ parsing

def read_session(path: Path):
    """-> (header, entries). header is None if the file has no session line."""
    header, entries = None, []
    try:
        fh = open(path, "r", encoding="utf-8")
    except OSError:
        return None, []
    with fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue  # tolerate a truncated final line
            if entry.get("type") == "session" and header is None:
                header = entry
            else:
                entries.append(entry)
    return header, entries


def to_epoch_ms(ts):
    """Session headers use ISO strings, messages use epoch milliseconds."""
    if ts is None:
        return None
    if isinstance(ts, (int, float)):
        return int(ts)
    try:
        return int(dt.datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return None


def iso(ms):
    if ms is None:
        return None
    return dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).isoformat(timespec="seconds")


# -------------------------------------------------------------------- text

def truncate(s, n):
    if s is None or len(s) <= n:
        return s
    return s[:n] + f"... [truncated, {len(s)} chars total]"


def text_of(content):
    """Flatten message content (str or content-block list) to plain text."""
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


def text_len(content):
    """Character length of message content, without building the joined string."""
    if content is None:
        return 0
    if isinstance(content, str):
        return len(content)
    if isinstance(content, list):
        n = 0
        for block in content:
            if isinstance(block, dict):
                n += len(block.get("text") or "")
            elif isinstance(block, str):
                n += len(block)
        return n
    return len(str(content))


def normalize_for_dedup(s: str) -> str:
    """Lowercase, strip punctuation, collapse whitespace - for exact-repeat detection."""
    s = s.lower().strip()
    s = re.sub(r"\s+", " ", s)
    s = re.sub(r"[^\w\s]", "", s)
    return s


def short_hash(s: str) -> str:
    return hashlib.sha1(s.encode("utf-8", "ignore")).hexdigest()[:10]


# ------------------------------------------------------------------ pricing

def load_catalog(path: Path = None):
    """Model price catalog -> ({(provider, id): price}, {id: price}).

    Prices are USD per 1M tokens. Use for counterfactuals only; actual spend
    is recorded per message in usage.cost.
    """
    path = path or MODELS_STORE
    prices, by_id = {}, {}
    if not Path(path).exists():
        return prices, by_id
    try:
        data = json.load(open(path, encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return prices, by_id
    for provider, blob in (data or {}).items():
        models = blob.get("models") if isinstance(blob, dict) else blob
        if not isinstance(models, list):
            continue
        for m in models:
            if not isinstance(m, dict) or not isinstance(m.get("cost"), dict):
                continue
            entry = {k: float(m["cost"].get(k) or 0.0) for k in COST_COMPONENTS}
            entry["name"] = m.get("name") or m.get("id")
            entry["contextWindow"] = m.get("contextWindow")
            prices[(provider, m.get("id"))] = entry
            by_id.setdefault(m.get("id"), entry)
    return prices, by_id


def price_for(prices, by_id, provider, model):
    return prices.get((provider, model)) or by_id.get(model)


def reprice(tokens, price):
    """USD for a token profile at catalog prices."""
    return sum(tokens.get(k, 0) * price.get(k, 0.0) for k in COST_COMPONENTS) / 1e6


# ---------------------------------------------------------------- exchanges

def turn_usage(msg):
    """-> (tokens dict, cost dict, total_cost) for an assistant message."""
    usage = msg.get("usage") or {}
    cost = usage.get("cost") or {}
    tokens = {k: int(usage.get(k) or 0) for k in TOKEN_FIELDS}
    costs = {k: float(cost.get(k) or 0.0) for k in COST_COMPONENTS}
    return tokens, costs, float(cost.get("total") or 0.0)


def iter_exchanges(entries):
    """Segment a session into exchanges: one user message plus everything the
    agent did in response, up to the next user message.

    This is the unit that lets behavior be priced -- a request and its whole
    cost tail. Yields dicts with:
      index, user_text, user_ts, assistant_turns, tools, tool_errors,
      models, tokens, cost, cost_by_component

    Caveat for callers: an exchange's cost includes re-sending all prior
    context, so later exchanges look more expensive regardless of what was
    asked. Compare exchanges by position as well as by dollars.
    """
    exchanges = []
    cur = None

    def new_exchange(text, ts, index):
        return {
            "index": index,
            "user_text": text,
            "user_ts": ts,
            "assistant_turns": 0,
            "tools": [],
            "tool_errors": [],
            "models": set(),
            "tokens": {k: 0 for k in TOKEN_FIELDS},
            "cost": 0.0,
            "cost_by_component": {k: 0.0 for k in COST_COMPONENTS},
        }

    for entry in entries:
        if entry.get("type") != "message":
            continue
        msg = entry.get("message") or {}
        role = msg.get("role")
        ms = to_epoch_ms(entry.get("timestamp"))

        if role == "user":
            if cur is not None:
                exchanges.append(cur)
            cur = new_exchange(text_of(msg.get("content")), ms, len(exchanges))
            continue
        if cur is None:
            # Agent activity before any user message (rare); keep it attributable.
            cur = new_exchange(None, ms, 0)

        if role == "assistant":
            tokens, costs, total = turn_usage(msg)
            cur["assistant_turns"] += 1
            cur["models"].add(f"{msg.get('provider')}/{msg.get('model')}")
            cur["cost"] += total
            for k, v in tokens.items():
                cur["tokens"][k] += v
            for k, v in costs.items():
                cur["cost_by_component"][k] += v
        elif role == "toolResult":
            name = msg.get("toolName") or "unknown"
            cur["tools"].append(name)
            if msg.get("isError"):
                cur["tool_errors"].append({
                    "tool": name,
                    "error": truncate(text_of(msg.get("content")), 200),
                })
        elif role == "bashExecution":
            cur["tools"].append("bashExecution")
            if msg.get("exitCode"):
                cur["tool_errors"].append({
                    "tool": "bashExecution",
                    "error": truncate(str(msg.get("command")), 200),
                })

    if cur is not None:
        exchanges.append(cur)
    for ex in exchanges:
        ex["models"] = sorted(m for m in ex["models"] if m)
    return exchanges
