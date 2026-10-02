#!/usr/bin/env python3
"""Attribute context (input-side) spend to the *content* that filled the context
window: files that were read, the comments inside them, always-loaded prompt
sections (AGENTS.md, skill descriptions, tool declarations), tool output, and
conversation text.

cost-analysis says how much each turn cost. exchange_costs.py says which
request a cost belongs to. This answers "which bytes in the context was I
paying for?".

Usage:
  content_costs.py [--scope all|project] [--cwd PATH] [--since DAYS] [--limit N]
                   [--after WHEN] [--before WHEN]
                   [--top N] [--chars-per-token F] [--thinking include|exclude]
                   [--path-glob GLOB] [--out PATH]

Method (per assistant turn = one LLM request):
  1. Rebuild the context pi sent for that request: walk the entry tree from the
     turn's parent to the root, honor the latest compaction on the path, apply
     context_edit entries, and replay system messages into the current prompt
     sections and tool declarations.
  2. Split that context into segments (one file read, one AGENTS.md, one skill
     description, one user message, ...), each with an estimated token count.
  3. Allocate the turn's *actual* provider-reported input-side cost across the
     segments:
       - input + cacheWrite cost -> segments new since the previous turn on this
         branch, up to their (calibrated) size; any excess write volume (cache
         miss / TTL expiry / non-caching provider) is spread over carried segments
       - cacheRead cost -> carried segments
     Estimated sizes are only used for *shares* within a turn, so attributed
     dollars reconcile to the real input-side spend.
  4. File content is split into content / comment / docstring / blank / license
     with pygments (falls back to a small regex classifier), so a file's cost
     can be broken down by what kind of text it was.

Output cost (tokens the model generated) is reported but not attributed; once
generated text is in context, its carry cost shows up under conversation/*.

This script performs NO interpretation -- it extracts, allocates, and ranks.
"""
import argparse
import collections
import fnmatch
import hashlib
import json
import os
import re
import shlex
import sys
from pathlib import Path

_SHARED = Path(__file__).resolve().parent
sys.path.insert(0, str(_SHARED))
import pi_sessions as ps  # noqa: E402

try:
    from pygments.lexers import get_lexer_for_filename
    from pygments.token import Comment, String
    from pygments.util import ClassNotFound
    HAVE_PYGMENTS = True
except ImportError:  # pragma: no cover
    HAVE_PYGMENTS = False

IMAGE_TOKENS = 1500  # rough per-image estimate; images are rare in these logs
MIX_CLASSES = ("content", "comment", "docstring", "blank", "license")
READ_FOOTER_RE = re.compile(
    r"\n*\[(?:\d+ more lines in file|Showing lines \d+-\d+ of \d+)[^\]\n]*\]\s*$")
PROJECT_INSTR_RE = re.compile(
    r'<project_instructions path="([^"]+)">.*?</project_instructions>', re.S)
SKILL_RE = re.compile(r"<skill>\s*<name>([^<]+)</name>.*?</skill>", re.S)
LICENSE_RE = re.compile(r"copyright|licen[cs]e|spdx-license-identifier", re.I)
WS_RE = re.compile(r"\s+")


def sha(s: str) -> str:
    return hashlib.sha1(s.encode("utf-8", "ignore")).hexdigest()[:12]


# --------------------------------------------------------------------------
# content classification (comments vs code)
# --------------------------------------------------------------------------

_MIX_CACHE = {}

# Fallback only: line-comment prefixes by extension.
_HASH = {".py", ".sh", ".bash", ".zsh", ".rb", ".yaml", ".yml", ".toml", ".conf",
         ".pl", ".r", ".ini", ".cfg", ".dockerfile", ".mk"}
_SLASH = {".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".java", ".c", ".h", ".cc",
          ".cpp", ".hpp", ".go", ".rs", ".kt", ".scala", ".groovy", ".swift", ".cs",
          ".css", ".scss", ".less", ".dart", ".php"}
_DASH = {".sql", ".lua", ".hs"}


def _weight(s: str) -> int:
    """Rough BPE-ish weight: runs of whitespace cost about one token."""
    return len(WS_RE.sub(" ", s))


def _finish(lines):
    """lines: list of (cls, weight, text) per line -> fractions per MIX_CLASSES.

    A contiguous comment block at the top of the file that mentions a
    copyright/license is reclassified as 'license'.
    """
    head, i = [], 0
    while i < len(lines) and (lines[i][0] in ("comment", "blank")
                              or lines[i][2].startswith("#!")):
        head.append(i)
        i += 1
    if head and LICENSE_RE.search(" ".join(lines[j][2] for j in head)):
        lines = [("license", w, t) if (j in head and c == "comment") else (c, w, t)
                 for j, (c, w, t) in enumerate(lines)]
    tot = collections.Counter()
    for c, w, _ in lines:
        tot[c] += w
    s = sum(tot.values())
    if not s:
        return None
    return {k: tot.get(k, 0) / s for k in MIX_CLASSES}


def _classify_pygments(path, text):
    try:
        lexer = get_lexer_for_filename(path, stripnl=False, ensurenl=False)
    except ClassNotFound:
        return None
    except Exception:
        return None
    # Per line: list of (kind, piece)
    lines, cur = [], []
    try:
        for ttype, value in lexer.get_tokens(text):
            if ttype in Comment.Preproc or ttype in Comment.PreprocFile:
                kind = "content"
            elif ttype in Comment:
                kind = "comment"
            elif ttype in String.Doc:
                kind = "docstring"
            else:
                kind = "content"
            parts = value.split("\n")
            for k, part in enumerate(parts):
                if part:
                    cur.append((kind, part))
                if k < len(parts) - 1:
                    lines.append(cur)
                    cur = []
    except Exception:
        return None
    if cur:
        lines.append(cur)
    out = []
    for pieces in lines:
        raw = "".join(p for _, p in pieces)
        if not raw.strip():
            out.append(("blank", 1, raw))
            continue
        kinds = {k for k, p in pieces if p.strip()}
        if kinds <= {"comment"}:
            out.append(("comment", _weight(raw) + 1, raw.strip()))
        elif kinds <= {"docstring"}:
            out.append(("docstring", _weight(raw) + 1, raw.strip()))
        else:
            # Mixed line: split weight between code and trailing comment/docstring.
            for k, p in pieces:
                if p.strip():
                    out.append((k, _weight(p), p))
            out.append(("content", 1, ""))  # the newline
    return _finish(out)


def _classify_regex(path, text):
    ext = os.path.splitext(path)[1].lower()
    if ext in _HASH:
        line_re, block = re.compile(r"^\s*#(?!!)"), None
    elif ext in _SLASH:
        line_re, block = re.compile(r"^\s*(//|\*)"), ("/*", "*/")
    elif ext in _DASH:
        line_re, block = re.compile(r"^\s*--"), None
    else:
        return None
    out, in_block = [], False
    for line in text.split("\n"):
        s = line.strip()
        if not s:
            out.append(("blank", 1, line))
        elif in_block:
            out.append(("comment", _weight(line) + 1, s))
            if block and block[1] in s:
                in_block = False
        elif block and s.startswith(block[0]):
            out.append(("comment", _weight(line) + 1, s))
            in_block = block[1] not in s[2:]
        elif line_re.match(line):
            out.append(("comment", _weight(line) + 1, s))
        else:
            out.append(("content", _weight(line) + 1, s))
    return _finish(out)


def classify_on_disk(path):
    """Mix of the file as it is *now*. Proxy for when the logged output can't be
    split per file (multi-file bash commands). Can drift from what was sent."""
    try:
        if os.path.getsize(path) > 2_000_000:
            return None
        with open(path, "r", encoding="utf-8") as fh:
            return classify(path, fh.read())
    except (OSError, UnicodeDecodeError):
        return None


def classify(path, text):
    """-> {class: fraction} or None if the file type can't be classified."""
    if not path or not text or not text.strip():
        return None
    ext = os.path.splitext(path)[1].lower() or os.path.basename(path)
    key = (ext, sha(text))
    if key in _MIX_CACHE:
        return _MIX_CACHE[key]
    mix = _classify_pygments(path, text) if HAVE_PYGMENTS else None
    if mix is None:
        mix = _classify_regex(path, text)
    _MIX_CACHE[key] = mix
    return mix


# --------------------------------------------------------------------------
# bash command parsing (which files did a shell command print?)
# --------------------------------------------------------------------------

READERS = {"cat", "nl", "bat", "batcat", "less", "more", "head", "tail", "sed", "tac"}
NO_OUTPUT = {"cd", "export", "set", "unset", "mkdir", "rm", "cp", "mv", "chmod", "chown",
             "touch", "sleep", "true", "false", "source", ".", "ln", "pushd", "popd",
             "trap", "local", "declare", "shopt", "wait", "exit", "return"}
WRAPPERS = {"timeout", "nohup", "sudo", "time", "env", "command", "exec", "stdbuf"}
OPERATORS = {";", "&&", "||", "|", "&", "|&", ";;", "(", ")", "{", "}"}
REDIRECTS = {">", ">>", "<", "<<", "<<<", ">&", "&>", "&>>", "<&", ">|"}
HEREDOC_RE = re.compile(r"<<-?\s*(['\"]?)(\w+)\1([^\n]*)\n.*?\n\s*\2[ \t]*(?=\n|$)", re.S)


def _resolve(p, cwd):
    p = os.path.expanduser(p)
    if not os.path.isabs(p):
        p = os.path.join(cwd or "/", p)
    return os.path.normpath(p)


def _looks_like_path(tok):
    return bool(tok) and not tok.startswith(("-", "$", "`")) and not tok.isdigit() \
        and tok not in ("/dev/null", "/dev/stdin", "-") and "=" not in tok[:1]


def _reader_files(verb, args):
    files, skip_next, script_seen = [], False, False
    has_e = any(a in ("-e", "-f") or a.startswith("--expression") for a in args)
    for i, a in enumerate(args):
        if skip_next:
            skip_next = False
            continue
        if verb == "sed" and (a == "-i" or a.startswith("-i") or a.startswith("--in-place")):
            return None  # in-place edit prints nothing
        if a.startswith("-"):
            if verb in ("head", "tail") and a in ("-n", "-c", "--lines", "--bytes"):
                skip_next = True
            if verb == "sed" and a in ("-e", "-f"):
                skip_next = True
            continue
        if verb == "sed" and not has_e and not script_seen:
            script_seen = True
            continue
        if _looks_like_path(a):
            files.append(a)
    return files


def parse_bash(command, cwd):
    """-> dict(files=[abs paths], file_cmds=int, output_cmds=int, verbs=[...],
               filtered=bool) or None if the command can't be tokenized."""
    cmd = HEREDOC_RE.sub(lambda m: " " + m.group(3), command or "")  # keep `> file` etc.
    cmd = cmd.replace("\n", " ; ")
    try:
        lex = shlex.shlex(cmd, posix=True, punctuation_chars=True)
        lex.whitespace_split = True
        toks = list(lex)
    except ValueError:
        return None

    # Split into simple commands, remembering whether each is piped onward and
    # whether it reads from a pipe (a downstream filter, not a new output).
    cmds, cur, from_pipe = [], [], False
    for t in toks:
        if t in OPERATORS:
            pipe = t in ("|", "|&")
            if cur:
                cmds.append((cur, pipe, from_pipe))
            cur, from_pipe = [], pipe
        else:
            cur.append(t)
    if cur:
        cmds.append((cur, False, from_pipe))

    here = cwd
    files, verbs, output_cmds, file_cmds, filtered = [], [], 0, 0, False
    for words, piped, from_pipe in cmds:
        # drop redirections; stdout to a file means nothing reaches the model
        w, i, to_file = [], 0, False
        while i < len(words):
            if words[i] in REDIRECTS:
                if words[i] in (">", ">>", ">|", "&>", "&>>") and i + 1 < len(words) \
                        and words[i + 1] not in ("/dev/stderr", "&2"):
                    to_file = True
                i += 2
                continue
            w.append(words[i])
            i += 1
        while w and re.match(r"^[A-Za-z_]\w*=", w[0]):
            w.pop(0)
        while w and os.path.basename(w[0]) in WRAPPERS:
            v = os.path.basename(w.pop(0))
            while w and w[0].startswith("-"):
                w.pop(0)
            if v == "timeout" and w and re.match(r"^\d+(\.\d+)?[smhd]?$", w[0]):
                w.pop(0)
        if not w:
            continue
        verb = os.path.basename(w[0])
        if verb == "cd":
            here = _resolve(w[1], here) if len(w) > 1 and _looks_like_path(w[1]) else here
            continue
        if verb in NO_OUTPUT or (to_file and not piped):
            continue
        if from_pipe:
            filtered = True
            continue
        got = None
        if verb in READERS:
            got = _reader_files(verb, w[1:])
            if got is None:  # sed -i
                continue
        elif verb == "git" and len(w) > 2 and w[1] == "show":
            got = [a.split(":", 1)[1] for a in w[2:] if ":" in a and not a.startswith("-")
                   and a.split(":", 1)[1]]
        output_cmds += 1
        if got:
            file_cmds += 1
            files.extend(_resolve(f, here) for f in got)
            filtered = filtered or piped
        else:
            verbs.append(verb)
    return {"files": files, "file_cmds": file_cmds, "output_cmds": output_cmds,
            "verbs": verbs, "filtered": filtered}


# --------------------------------------------------------------------------
# segments
# --------------------------------------------------------------------------

def _seg(key, cat, label, chars, images=0, **meta):
    s = {"key": key, "cat": cat, "label": label, "chars": chars, "images": images}
    s.update(meta)
    return s


def _blocks(content):
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    return [b for b in (content or []) if isinstance(b, dict)]


def _text_and_images(content):
    text, images = [], 0
    for b in _blocks(content):
        if b.get("type") == "text":
            text.append(b.get("text") or "")
        elif b.get("type") == "image":
            images += 1
    return "\n".join(text), images


def _file_seg(key, kind, path, text, images, classify_text, **meta):
    if classify_text is not None:
        mix, src = classify(path, classify_text), "logged"
    else:
        mix, src = classify_on_disk(path), "disk"
    return _seg(key, f"file/{kind}", path, len(text), images, file=path, kind=kind,
                mix=mix, mix_source=src if mix else None, **meta)


def entry_segments(entry, cwd, calls, include_thinking):
    """Segments contributed by one non-system entry. `calls` maps toolCallId ->
    (toolName, arguments) for the session."""
    eid = entry.get("id")
    etype = entry.get("type")
    if etype == "compaction":
        return [_seg((eid, 0), "compaction/summary", "summary", len(entry.get("summary") or ""))]
    if etype == "branch_summary":
        return [_seg((eid, 0), "compaction/branch_summary", "branch_summary",
                     len(entry.get("summary") or ""))]
    if etype == "custom_message":
        text, imgs = _text_and_images(entry.get("content"))
        return [_seg((eid, 0), "custom", entry.get("customType") or "unknown", len(text), imgs)]
    if etype != "message":
        return []

    msg = entry.get("message") or {}
    role = msg.get("role")
    if role == "user":
        text, imgs = _text_and_images(msg.get("content"))
        return [_seg((eid, 0), "conversation/user", "user", len(text), imgs)]
    if role == "bashExecution":
        n = len(str(msg.get("command") or "")) + len(str(msg.get("output") or ""))
        return [_seg((eid, 0), "conversation/user_bash", "user_bash", n)]
    if role in ("custom", "hookMessage"):
        text, imgs = _text_and_images(msg.get("content"))
        return [_seg((eid, 0), "custom", msg.get("customType") or "unknown", len(text), imgs)]

    if role == "assistant":
        segs = []
        for i, b in enumerate(_blocks(msg.get("content"))):
            t = b.get("type")
            if t == "text":
                segs.append(_seg((eid, i), "conversation/assistant_text", "assistant_text",
                                 len(b.get("text") or "")))
            elif t == "thinking" and include_thinking:
                segs.append(_seg((eid, i), "conversation/assistant_thinking", "thinking",
                                 len(b.get("thinking") or "")))
            elif t == "toolCall":
                name = b.get("name") or "unknown"
                args = b.get("arguments") or {}
                n = len(json.dumps(args, ensure_ascii=False))
                if name == "write" and args.get("path"):
                    p = _resolve(args["path"], cwd)
                    body = str(args.get("content") or "")
                    segs.append(_file_seg((eid, i), "write", p, "x" * n, 0, body))
                elif name == "edit" and args.get("path"):
                    p = _resolve(args["path"], cwd)
                    body = "\n".join(str(e.get("newText") or "") + "\n" + str(e.get("oldText") or "")
                                     for e in (args.get("edits") or []) if isinstance(e, dict))
                    segs.append(_file_seg((eid, i), "edit", p, "x" * n, 0, body))
                else:
                    segs.append(_seg((eid, i), "toolcall", name, n))
        return segs

    if role == "toolResult":
        name = msg.get("toolName") or "unknown"
        text, imgs = _text_and_images(msg.get("content"))
        if msg.get("isError"):
            return [_seg((eid, 0), "tool_error", name, len(text), imgs)]
        _, args = calls.get(msg.get("toolCallId"), (name, {}))
        args = args or {}
        if name == "read" and args.get("path"):
            p = _resolve(args["path"], cwd)
            body = READ_FOOTER_RE.sub("", text)
            rng = (args.get("offset"), args.get("limit"))
            return [_file_seg((eid, 0), "read", p, text, imgs, body, range=rng)]
        if name == "bash":
            parsed = parse_bash(args.get("command") or "", cwd)
            if parsed is None:
                return [_seg((eid, 0), "bash", "unparsed", len(text), imgs)]
            segs = []
            n_out = max(parsed["output_cmds"], 1)
            file_share = parsed["file_cmds"] / n_out if parsed["files"] else 0.0
            if parsed["files"]:
                files = parsed["files"]
                sizes = []
                for f in files:
                    try:
                        sizes.append(os.path.getsize(f))
                    except OSError:
                        sizes.append(None)
                if all(s for s in sizes):
                    tot = sum(sizes)
                    weights = [s / tot for s in sizes]
                else:
                    weights = [1 / len(files)] * len(files)
                single = len(files) == 1 and parsed["output_cmds"] == 1
                for j, (f, wt) in enumerate(zip(files, weights)):
                    share = file_share * wt
                    segs.append(_file_seg(
                        (eid, j), "bash", f, "x" * int(len(text) * share), 0,
                        text if single else None,
                        approx=not single, filtered=parsed["filtered"],
                        range=("bash", args.get("command"))))
            rest = int(len(text) * (1 - file_share))
            if rest or not segs:
                verb = parsed["verbs"][0] if parsed["verbs"] else "other"
                segs.append(_seg((eid, 999), "bash", verb, rest, imgs))
            return segs
        return [_seg((eid, 0), "tool", name, len(text), imgs)]
    return []


_SYS_CACHE = {}


def system_segments(sections, tools):
    """Segments for the replayed system prompt + tool declarations."""
    segs = []
    for name, text in sections.items():
        text = text if isinstance(text, str) else json.dumps(text)
        ck = (name, sha(text))
        if ck not in _SYS_CACHE:
            parts = []
            rest = text
            if name == "project_context":
                for m in PROJECT_INSTR_RE.finditer(text):
                    parts.append(("system/agents_md", m.group(1), len(m.group(0))))
                rest = PROJECT_INSTR_RE.sub("", text)
            elif name == "skills":
                for m in SKILL_RE.finditer(text):
                    parts.append(("system/skill", m.group(1).strip(), len(m.group(0))))
                rest = SKILL_RE.sub("", text)
            parts.append(("system/section", name, len(rest)))
            _SYS_CACHE[ck] = parts
        for cat, label, n in _SYS_CACHE[ck]:
            segs.append(_seg(("sys", cat, label, ck[1]), cat, label, n))
    for name, decl in tools.items():
        segs.append(_seg(("sys", "tool_decl", name, sha(decl)), "system/tool_decl", name, len(decl)))
    return segs


def apply_system(msg, sections, tools):
    for k, v in (msg.get("sections") or {}).items():
        if v is None:
            sections.pop(k, None)
        else:
            sections[k] = v
    if isinstance(msg.get("content"), str) and msg["content"].strip():
        sections["_content"] = msg["content"]
    for t in msg.get("toolsAdded") or []:
        if isinstance(t, dict) and t.get("name"):
            tools[t["name"]] = json.dumps(t, ensure_ascii=False, sort_keys=True)
    for t in msg.get("toolsRemoved") or []:
        name = t.get("name") if isinstance(t, dict) else t
        tools.pop(name, None)


def is_system(entry):
    return entry.get("type") == "message" and (entry.get("message") or {}).get("role") == "system"


# --------------------------------------------------------------------------
# per-session allocation
# --------------------------------------------------------------------------

def analyze_session(path, cpt, include_thinking, stats, calib, after_ms=None, before_ms=None):
    """after_ms/before_ms limit which turns are *priced*. Context is still rebuilt
    from the full history, because an in-window turn carries out-of-window
    content - clipping the entries would drop exactly what it paid to carry."""
    header, entries = ps.read_session(path)
    if header is None:
        return None
    sid = header.get("id")
    cwd = header.get("cwd") or "/"
    byid = {e.get("id"): e for e in entries if e.get("id")}
    calls = {}
    for e in entries:
        m = e.get("message") or {}
        if e.get("type") == "message" and m.get("role") == "assistant":
            for b in _blocks(m.get("content")):
                if b.get("type") == "toolCall":
                    calls[b.get("id")] = (b.get("name"), b.get("arguments"))
    seg_cache = {}

    def segs_for(e):
        eid = e.get("id")
        if eid not in seg_cache:
            seg_cache[eid] = entry_segments(e, cwd, calls, include_thinking)
        return seg_cache[eid]

    def est(s):
        return s["chars"] / cpt + s["images"] * IMAGE_TOKENS

    keysets = {}  # assistant entry id -> set of segment keys in its context
    turns = 0
    session_cost = {"input_side": 0.0, "attributed": 0.0, "output": 0.0}

    for e in entries:
        m = e.get("message") or {}
        if not (e.get("type") == "message" and m.get("role") == "assistant"):
            continue
        priced = ps.in_window(ps.to_epoch_ms(e.get("timestamp")), after_ms, before_ms)
        if not priced and before_ms is not None and \
                (ps.to_epoch_ms(e.get("timestamp")) or 0) > before_ms:
            break  # past the window; nothing later can be priced
        if priced:
            turns += 1
        usage = m.get("usage") or {}
        cost = usage.get("cost") or {}
        tok_in = int(usage.get("input") or 0)
        tok_cr = int(usage.get("cacheRead") or 0)
        tok_cw = int(usage.get("cacheWrite") or 0)
        c_in = float(cost.get("input") or 0.0)
        c_cr = float(cost.get("cacheRead") or 0.0)
        c_cw = float(cost.get("cacheWrite") or 0.0)
        if not priced:
            c_in = c_cr = c_cw = 0.0  # still walk the turn so keysets stay right
        session_cost["input_side"] += c_in + c_cr + c_cw
        if priced:
            session_cost["output"] += float(cost.get("output") or 0.0)

        # ---- 1. rebuild the context for this request ------------------------
        path_entries, cur = [], byid.get(e.get("parentId"))
        seen = set()
        while cur is not None and cur.get("id") not in seen:
            seen.add(cur.get("id"))
            path_entries.append(cur)
            cur = byid.get(cur.get("parentId"))
        path_entries.reverse()

        ci = max((i for i, x in enumerate(path_entries) if x.get("type") == "compaction"),
                 default=None)
        sections, tools = {}, {}
        for i, x in enumerate(path_entries):
            if ci is not None and i == ci and isinstance(path_entries[ci].get("systemMessage"), dict):
                sections, tools = {}, {}
                apply_system(path_entries[ci]["systemMessage"], sections, tools)
            elif is_system(x) and (ci is None or i > ci or
                                   not isinstance(path_entries[ci].get("systemMessage"), dict)):
                apply_system(x["message"], sections, tools)
        if ci is None:
            selected = [x for x in path_entries if not is_system(x)]
        else:
            fk_id = path_entries[ci].get("firstKeptEntryId")
            fk = next((i for i, x in enumerate(path_entries) if x.get("id") == fk_id), ci)
            selected = ([x for x in path_entries[fk:ci] if not is_system(x)]
                        + [path_entries[ci]]
                        + [x for x in path_entries[ci + 1:] if not is_system(x)])
        edits = {x.get("targetId"): x.get("replacement")
                 for x in path_entries if x.get("type") == "context_edit"}

        visible = system_segments(sections, tools)
        for x in selected:
            xid = x.get("id")
            if xid in edits:
                rep = edits[xid]
                if rep is None:
                    continue
                text, imgs = _text_and_images(rep)
                role = (x.get("message") or {}).get("role") or x.get("type")
                visible.append(_seg((xid, "edited"), "edited", role, len(text), imgs))
                continue
            visible.extend(segs_for(x))

        # ---- 2. new vs carried ----------------------------------------------
        prev_asst = next((x.get("id") for x in reversed(path_entries)
                          if x.get("type") == "message"
                          and (x.get("message") or {}).get("role") == "assistant"), None)
        prev_keys = keysets.get(prev_asst, set())
        keysets[e.get("id")] = {s["key"] for s in visible}
        new = [s for s in visible if s["key"] not in prev_keys]
        carried = [s for s in visible if s["key"] in prev_keys]

        sum_est = sum(est(s) for s in visible)
        ctx_actual = tok_in + tok_cr + tok_cw
        scale = ctx_actual / sum_est if sum_est and ctx_actual else 1.0
        if sum_est and ctx_actual and (c_in + c_cr + c_cw) > 0:
            calib.append(scale)
        if not priced:
            continue

        # ---- 3. allocate actual cost ----------------------------------------
        write_cost, write_tok = c_in + c_cw, tok_in + tok_cw
        new_est = sum(est(s) for s in new)
        car_est = sum(est(s) for s in carried)
        frac_new = min(1.0, new_est * scale / write_tok) if (write_tok and new_est) else 0.0
        to_new = write_cost * frac_new
        to_car = write_cost - to_new + c_cr
        if not carried:
            to_new, to_car = to_new + to_car, 0.0
        if not new and not carried:
            continue

        # Redundant re-reads: same path + same range already visible earlier in
        # this context, with no write/edit of that path in between.
        order = {id(s): i for i, s in enumerate(visible)}
        for s in new:
            if s.get("kind") not in ("read", "bash"):
                continue
            for o in reversed(visible[:order[id(s)]]):
                if o.get("file") != s["file"]:
                    continue
                if o.get("kind") in ("write", "edit"):
                    break
                if o.get("range") == s.get("range") and o["key"] in prev_keys:
                    s["_redundant"] = True
                    break

        def give(group, total, group_est, first):
            if not group:
                return
            for s in group:
                share = est(s) / group_est if group_est else 1 / len(group)
                c = total * share
                st = stats[(sid, s["key"])]
                if not st["meta"]:
                    st["meta"] = {k: v for k, v in s.items() if k not in ("key",)}
                    st["meta"]["session"] = sid
                    st["meta"]["cwd"] = cwd
                if s.get("_redundant"):
                    st["meta"]["_redundant"] = True
                if first:
                    st["first_cost"] += c
                    st["tokens"] = max(st["tokens"], est(s) * scale)
                else:
                    st["carry_cost"] += c
                st["turns"] += 1
                st["token_turns"] += est(s) * scale
                session_cost["attributed"] += c

        give(new, to_new, new_est, True)
        give(carried, to_car, car_est, False)

    return {"session_id": sid, "turns": turns, **session_cost}


# --------------------------------------------------------------------------
# aggregation
# --------------------------------------------------------------------------

def _new_bucket():
    return {"cost": 0.0, "first_cost": 0.0, "carry_cost": 0.0, "tokens": 0.0,
            "token_turns": 0.0, "segments": 0, "turns": 0, "sessions": set()}


def _add(b, st):
    c = st["first_cost"] + st["carry_cost"]
    b["cost"] += c
    b["first_cost"] += st["first_cost"]
    b["carry_cost"] += st["carry_cost"]
    b["tokens"] += st["tokens"]
    b["token_turns"] += st["token_turns"]
    b["segments"] += 1
    b["turns"] += st["turns"]
    b["sessions"].add(st["meta"]["session"])
    return c


def _row(b, total, **extra):
    r = dict(extra)
    r.update({
        "cost_usd": round(b["cost"], 4),
        "share_of_input_side": round(b["cost"] / total, 4) if total else 0.0,
        "first_send_cost_usd": round(b["first_cost"], 4),
        "carry_cost_usd": round(b["carry_cost"], 4),
        "est_tokens_sent": round(b["tokens"]),
        "est_token_turns": round(b["token_turns"]),
        "segments": b["segments"],
        "sessions": len(b["sessions"]),
    })
    return r


def summarize(stats, sessions, calib, top_n, path_glob, cpt, include_thinking):
    input_side = sum(s["input_side"] for s in sessions)
    attributed = sum(s["attributed"] for s in sessions)
    output = sum(s["output"] for s in sessions)

    by_cat = collections.defaultdict(_new_bucket)
    always = collections.defaultdict(_new_bucket)
    files = collections.defaultdict(lambda: {
        **_new_bucket(), "kinds": collections.Counter(), "mix_cost": collections.Counter(),
        "approx_cost": 0.0, "redundant": 0, "redundant_cost": 0.0, "cwds": set()})
    dirs = collections.defaultdict(_new_bucket)
    exts = collections.defaultdict(_new_bucket)
    labels = collections.defaultdict(_new_bucket)
    mix_read = collections.Counter()   # file content shown to the model (read/bash)
    mix_wrote = collections.Counter()  # file content the agent wrote (write/edit args)
    mix_disk_cost = 0.0                # read-side cost classified from current file on disk

    for (_sid, _key), st in stats.items():
        meta = st["meta"]
        cat = meta["cat"]
        c = _add(by_cat[cat], st)
        _add(labels[(cat, meta["label"])], st)
        if cat.startswith("system/"):
            _add(always[(cat, meta["label"])], st)
        f = meta.get("file")
        if not f:
            continue
        if path_glob and not fnmatch.fnmatch(f, path_glob):
            continue
        fb = files[f]
        _add(fb, st)
        fb["kinds"][meta["kind"]] += 1
        fb["cwds"].add(meta.get("cwd"))
        if meta.get("approx"):
            fb["approx_cost"] += c
        if meta.get("_redundant"):
            fb["redundant"] += 1
            fb["redundant_cost"] += c
        mix = meta.get("mix")
        target = mix_wrote if meta["kind"] in ("write", "edit") else mix_read
        if mix and meta.get("mix_source") == "disk" and target is mix_read:
            mix_disk_cost += c
        if mix:
            for k, frac in mix.items():
                fb["mix_cost"][k] += c * frac
                target[k] += c * frac
        else:
            fb["mix_cost"]["unclassified"] += c
            target["unclassified"] += c
        _add(dirs[os.path.dirname(f)], st)
        _add(exts[os.path.splitext(f)[1].lower() or "(none)"], st)

    def top(d, keyname, n=top_n):
        rows = [_row(b, input_side, **{keyname: k}) for k, b in d.items()]
        rows.sort(key=lambda r: r["cost_usd"], reverse=True)
        return rows[:n]

    file_rows = []
    for f, b in files.items():
        r = _row(b, input_side, path=f)
        mc = b["mix_cost"]
        r.update({
            "reads_by_kind": dict(b["kinds"]),
            "avg_turns_in_context": round(b["turns"] / b["segments"], 1) if b["segments"] else 0,
            "cost_by_content_class": {k: round(v, 4) for k, v in mc.items() if v},
            "comment_cost_usd": round(mc["comment"] + mc["docstring"] + mc["license"], 4),
            "approx_attributed_cost_usd": round(b["approx_cost"], 4),
            "redundant_reads": b["redundant"],
            "redundant_read_cost_usd": round(b["redundant_cost"], 4),
            "projects": sorted(x for x in b["cwds"] if x),
        })
        file_rows.append(r)
    file_rows.sort(key=lambda r: r["cost_usd"], reverse=True)

    def mix_summary(counter):
        tot = sum(counter.values())
        return {
            "cost_usd": round(tot, 4),
            "by_class": {k: {"cost_usd": round(v, 4), "share": round(v / tot, 4) if tot else 0.0}
                         for k, v in sorted(counter.items(), key=lambda kv: -kv[1])},
        }

    comment_rows = sorted(
        (r for r in file_rows if r["comment_cost_usd"] > 0),
        key=lambda r: r["comment_cost_usd"], reverse=True)[:top_n]
    redundant_rows = sorted(
        (r for r in file_rows if r["redundant_reads"]),
        key=lambda r: r["redundant_read_cost_usd"], reverse=True)[:top_n]

    always_rows = [_row(b, input_side, category=k[0], label=k[1],
                        avg_est_tokens_per_turn=round(b["token_turns"] / b["turns"]) if b["turns"] else 0)
                   for k, b in always.items()]
    always_rows.sort(key=lambda r: r["cost_usd"], reverse=True)

    q = sorted(calib)

    def pct(p):
        return round(q[min(len(q) - 1, int(p * len(q)))], 3) if q else None

    return {
        "meta": {
            "sessions": len(sessions),
            "assistant_turns": sum(s["turns"] for s in sessions),
            "chars_per_token": cpt,
            "thinking_in_context": include_thinking,
            "classifier": "pygments" if HAVE_PYGMENTS else "regex-fallback",
            "path_glob": path_glob,
            "calibration": {
                "note": ("actual context tokens / estimated tokens per paid turn. "
                         "Stable values near 1 mean the segment model matches what was "
                         "sent; a wide spread means shares within a turn are less reliable."),
                "median": pct(0.5), "p10": pct(0.1), "p90": pct(0.9),
            },
        },
        "totals": {
            "input_side_cost_usd": round(input_side, 4),
            "attributed_cost_usd": round(attributed, 4),
            "unattributed_cost_usd": round(input_side - attributed, 4),
            "output_cost_usd_not_attributed": round(output, 4),
        },
        "by_category": top(by_cat, "category", n=10 ** 6),
        "top_labels": top(labels, "category_label", n=top_n * 2),
        "always_loaded": always_rows[: top_n * 2],
        "files": file_rows[:top_n],
        "directories": top(dirs, "directory"),
        "extensions": top(exts, "extension"),
        "comments": {
            "files_shown_to_model": {
                **mix_summary(mix_read),
                "cost_classified_from_current_disk_copy_usd": round(mix_disk_cost, 4),
            },
            "files_written_by_agent": mix_summary(mix_wrote),
            "top_files_by_comment_cost": [
                {"path": r["path"], "comment_cost_usd": r["comment_cost_usd"],
                 "cost_usd": r["cost_usd"],
                 "comment_share": round(r["comment_cost_usd"] / r["cost_usd"], 3) if r["cost_usd"] else 0.0}
                for r in comment_rows],
        },
        "redundant_reads": [
            {"path": r["path"], "redundant_reads": r["redundant_reads"],
             "redundant_read_cost_usd": r["redundant_read_cost_usd"]} for r in redundant_rows],
        "whatif_upper_bounds": {
            "note": ("Holding everything else fixed. Removing content can cost turns if the "
                     "model then needs to re-derive what a comment explained; treat as ceilings."),
            "strip_comments_docstrings_from_reads_usd": round(
                mix_read["comment"] + mix_read["docstring"] + mix_read["license"], 4),
            "strip_license_headers_from_reads_usd": round(mix_read["license"], 4),
            "avoid_redundant_rereads_usd": round(sum(b["redundant_cost"] for b in files.values()), 4),
        },
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scope", choices=["project", "all"], default="all")
    ap.add_argument("--cwd", default=os.getcwd())
    ap.add_argument("--since", type=float)
    ap.add_argument("--limit", type=int)
    ap.add_argument("--top", type=int, default=15)
    ap.add_argument("--chars-per-token", type=float, default=4.0)
    ap.add_argument("--thinking", choices=["include", "exclude"], default="include",
                    help="whether prior-turn thinking blocks count as context (default include)")
    ap.add_argument("--path-glob", help="restrict file/dir/extension/comment views to paths matching GLOB")
    ap.add_argument("--out")
    ps.add_window_args(ap)
    args = ap.parse_args()
    after_ms, before_ms = ps.window_from_args(args)

    stats = collections.defaultdict(lambda: {"first_cost": 0.0, "carry_cost": 0.0, "tokens": 0.0,
                                             "token_turns": 0.0, "turns": 0, "meta": None})
    calib, sessions = [], []
    include_thinking = args.thinking == "include"
    for path in ps.iter_session_files(args.scope, args.cwd, since=args.since, limit=args.limit,
                                      after_ms=after_ms):
        r = analyze_session(path, args.chars_per_token, include_thinking, stats, calib,
                            after_ms, before_ms)
        if r and r["turns"]:
            sessions.append(r)
    report = summarize(stats, sessions, calib, args.top, args.path_glob,
                       args.chars_per_token, include_thinking)
    report["meta"]["window"] = ps.window_meta(after_ms, before_ms)
    text = json.dumps(report, indent=2)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
        t = report["totals"]
        print(f"wrote {args.out} ({report['meta']['sessions']} sessions, "
              f"${t['attributed_cost_usd']:.4f} of ${t['input_side_cost_usd']:.4f} input-side attributed)")
    else:
        print(text)


if __name__ == "__main__":
    main()
