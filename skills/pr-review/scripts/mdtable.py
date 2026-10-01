#!/usr/bin/env python3
"""mdtable.py - align markdown table columns for reading in a plain text editor.

Rewrites every pipe table in a file so columns line up in a monospace font.
Renderers do not care; humans reading the raw file do, and these artifacts are
read raw far more often than they are rendered.

Leaves alone:
  - anything inside a fenced code block, which may contain literal pipes
  - a column wider than --max-col, so one 400-character evidence cell does not
    pad every other row out to 400 characters

Preserves:
  - alignment markers in the separator row (:---, ---:, :---:)
  - leading indentation, so tables nested in list items stay nested
  - escaped pipes (\\|) inside cells

Usage:
    mdtable.py FILE [FILE ...]          rewrite in place
    mdtable.py FILE --check             exit 1 if anything would change
    mdtable.py FILE --stdout            print instead of writing
"""
import argparse
import re
import sys
from pathlib import Path

DEFAULT_MAX_COL = 60
SPLIT = re.compile(r"(?<!\\)\|")
# Capture the full run: a ````markdown block may contain ``` blocks, and a
# closing fence must be at least as long as the one that opened it.
FENCE = re.compile(r"^\s*(`{3,}|~{3,})")


def is_separator(cells):
    return bool(cells) and all(re.fullmatch(r":?-{1,}:?", c.strip()) for c in cells)


def split_row(line):
    """Cells of a pipe row, without the outer empties. None if not a row."""
    s = line.strip()
    if not s.startswith("|"):
        return None
    parts = SPLIT.split(s)
    if len(parts) < 3:
        return None
    if parts[0].strip() or parts[-1].strip():
        return None  # not delimited by leading and trailing pipes
    return [p.strip() for p in parts[1:-1]]


def markers(cell):
    """(left_colon, right_colon) exactly as written, so `:---` survives."""
    c = cell.strip()
    return c.startswith(":"), c.endswith(":") and len(c) > 1


def alignment(cell):
    left, right = markers(cell)
    if left and right:
        return "center"
    if right:
        return "right"
    return "left"


def pad(text, width, align):
    if len(text) >= width:
        return text
    space = width - len(text)
    if align == "right":
        return " " * space + text
    if align == "center":
        half = space // 2
        return " " * half + text + " " * (space - half)
    return text + " " * space


def format_block(rows, indent, max_col):
    """rows: list of cell-lists, including the separator at index 1 if present."""
    sep_at = 1 if len(rows) > 1 and is_separator(rows[1]) else None
    ncols = max(len(r) for r in rows)
    rows = [r + [""] * (ncols - len(r)) for r in rows]

    aligns = ["left"] * ncols
    marks = [(False, False)] * ncols
    if sep_at is not None:
        aligns = [alignment(c) for c in rows[sep_at]]
        marks = [markers(c) for c in rows[sep_at]]

    widths = []
    for i in range(ncols):
        content = [len(r[i]) for j, r in enumerate(rows) if j != sep_at]
        w = max(content) if content else 0
        # Floor of 3: a separator cannot be shorter than `---`, so a narrower
        # column would leave the content rows out of step with it.
        widths.append(max(min(w, max_col), 3))

    out = []
    for j, r in enumerate(rows):
        if j == sep_at:
            cells = []
            for i in range(ncols):
                w = widths[i]
                left, right = marks[i]
                body = "-" * (w - int(left) - int(right))
                cells.append((":" if left else "") + body + (":" if right else ""))
            out.append(indent + "| " + " | ".join(cells) + " |")
        else:
            cells = [pad(r[i], widths[i], aligns[i]) for i in range(ncols)]
            out.append((indent + "| " + " | ".join(cells) + " |").rstrip())
    return out


def format_tables(text, max_col=DEFAULT_MAX_COL):
    lines = text.splitlines()
    out, i, in_fence, fence_tok = [], 0, False, None

    while i < len(lines):
        line = lines[i]

        if (m := FENCE.match(line)):
            tok = m.group(1)
            if not in_fence:
                in_fence, fence_tok = True, tok
            elif tok[0] == fence_tok[0] and len(tok) >= len(fence_tok):
                in_fence, fence_tok = False, None
            out.append(line)
            i += 1
            continue

        if in_fence or split_row(line) is None:
            out.append(line)
            i += 1
            continue

        block, start = [], i
        while i < len(lines) and not in_fence:
            cells = split_row(lines[i])
            if cells is None:
                break
            block.append(cells)
            i += 1

        # A single pipe line with no separator beneath is probably not a table.
        if len(block) < 2 or not is_separator(block[1]):
            out.extend(lines[start:i])
            continue

        indent = lines[start][:len(lines[start]) - len(lines[start].lstrip())]
        out.extend(format_block(block, indent, max_col))

    trailing = "\n" if text.endswith("\n") else ""
    return "\n".join(out) + trailing


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("files", nargs="+")
    ap.add_argument("--max-col", type=int, default=DEFAULT_MAX_COL,
                    help=f"do not pad a column wider than this (default {DEFAULT_MAX_COL})")
    ap.add_argument("--check", action="store_true", help="exit 1 if anything would change")
    ap.add_argument("--stdout", action="store_true", help="print instead of writing")
    args = ap.parse_args()

    changed = []
    for f in args.files:
        p = Path(f)
        if not p.exists():
            sys.exit(f"no such file: {p}")
        src = p.read_text()
        dst = format_tables(src, args.max_col)
        if args.stdout:
            print(dst, end="")
            continue
        if src != dst:
            changed.append(str(p))
            if not args.check:
                p.write_text(dst)

    if args.stdout:
        return
    if args.check:
        for c in changed:
            print(f"would reformat: {c}")
        sys.exit(1 if changed else 0)
    for c in changed:
        print(f"formatted: {c}")
    if not changed:
        print("already aligned")


if __name__ == "__main__":
    main()
