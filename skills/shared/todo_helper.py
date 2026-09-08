#!/usr/bin/env python3
"""Shared helper for the todo-runner and todo-pairing skills.

These are the mechanical, deterministic parts of the workflow (finding a
task, slugifying it into a branch name, checking a box, building a PR
link) — doing them with a script instead of freehand editing avoids
misparsing a checkbox or mangling the file at 3am.

Subcommands:
  next FILE [--after N]
      Print "<line_number>\t<task text>" for the first unchecked
      "- [ ]" item in FILE, top to bottom, followed by any indented
      lines directly beneath it (context notes the user added -- extra
      detail, links, acceptance criteria) each on their own line
      exactly as written. Context ends at the first blank line or line
      indented no deeper than the checkbox itself. With --after N,
      starts the search after line N (1-indexed) instead of from the
      top -- use this to fetch the next candidate once an earlier task
      has been skipped, without losing file order. Exits 1 with no
      output if none found.

  slug TEXT...
      Print a branch/URL-safe slug built from the first few words of TEXT.

  checkoff FILE LINE
      Flip the checkbox on line LINE (1-indexed) of FILE from
      "[ ]" to "[x]". Errors (without changing the file) if that line
      doesn't look like a checkbox item — used as a safety check that
      you're checking off the right line.

  uncheck FILE LINE
      The reverse of checkoff: flips line LINE from "[x]"/"[X]" back
      to "[ ]". Same safety check as checkoff.

  add-context FILE LINE TEXT...
      Insert "- **CONTEXT NEEDED:** TEXT" as a new indented bullet
      directly under the checkbox on line LINE (1-indexed), after any
      context already there, so it shows up in a future `next` call.
      TEXT is joined from the remaining args and collapsed to one line.
      Same safety check as checkoff.

  default-branch
      Print the repo's default branch (from origin/HEAD), falling back
      to "main" if it can't be determined.

  pr-link BRANCH
      Print a compare/merge-request URL for BRANCH based on the
      `origin` remote. Supports github.com and gitlab.com URL shapes;
      falls back to a generic /compare/ URL for anything else.
"""
import re
import sys
import subprocess

CHECKBOX_UNCHECKED_RE = re.compile(r"^(\s*[-*]\s*\[)( )(\]\s*)(.*)$")
CHECKBOX_ANY_RE = re.compile(r"^(\s*[-*]\s*\[)( |x|X)(\]\s*)(.*)$")


def indent_of(line):
    return len(line) - len(line.lstrip(" \t"))


def context_end(lines, checkbox_idx):
    """Index just past the last context line under lines[checkbox_idx]."""
    checkbox_indent = indent_of(lines[checkbox_idx])
    i = checkbox_idx + 1
    while i < len(lines):
        line = lines[i]
        if not line.strip():
            break
        if indent_of(line) <= checkbox_indent:
            break
        i += 1
    return i


def cmd_next(path, after=0):
    with open(path, encoding="utf-8") as f:
        lines = f.readlines()
    for i, line in enumerate(lines, start=1):
        if i <= after:
            continue
        m = CHECKBOX_UNCHECKED_RE.match(line)
        if m:
            print(f"{i}\t{m.group(4).strip()}")
            for context_line in lines[i:context_end(lines, i - 1)]:
                print(context_line.rstrip("\n"))
            return 0
    return 1


def slugify(text, max_words=7):
    words = re.findall(r"[a-zA-Z0-9]+", text.lower())[:max_words]
    return "-".join(words) or "task"


def cmd_slug(words):
    print(slugify(" ".join(words)))
    return 0


def _set_checkbox(path, line_no, mark):
    with open(path, encoding="utf-8") as f:
        lines = f.readlines()
    idx = int(line_no) - 1
    if idx < 0 or idx >= len(lines):
        print(f"Line {line_no} is out of range for {path}", file=sys.stderr)
        return 1
    m = CHECKBOX_ANY_RE.match(lines[idx])
    if not m:
        print(f"Line {line_no} of {path} doesn't look like a checkbox item:\n{lines[idx]!r}", file=sys.stderr)
        return 1
    lines[idx] = f"{m.group(1)}{mark}{m.group(3)}{m.group(4)}\n"
    with open(path, "w", encoding="utf-8") as f:
        f.writelines(lines)
    return 0


def cmd_checkoff(path, line_no):
    return _set_checkbox(path, line_no, "x")


def cmd_uncheck(path, line_no):
    return _set_checkbox(path, line_no, " ")


def cmd_add_context(path, line_no, text):
    with open(path, encoding="utf-8") as f:
        lines = f.readlines()
    idx = int(line_no) - 1
    if idx < 0 or idx >= len(lines):
        print(f"Line {line_no} is out of range for {path}", file=sys.stderr)
        return 1
    m = CHECKBOX_ANY_RE.match(lines[idx])
    if not m:
        print(f"Line {line_no} of {path} doesn't look like a checkbox item:\n{lines[idx]!r}", file=sys.stderr)
        return 1
    text = " ".join(text.split())
    indent = " " * (indent_of(lines[idx]) + 2)
    lines.insert(context_end(lines, idx), f"{indent}- **CONTEXT NEEDED:** {text}\n")
    with open(path, "w", encoding="utf-8") as f:
        f.writelines(lines)
    return 0


def default_branch():
    try:
        ref = subprocess.check_output(
            ["git", "symbolic-ref", "refs/remotes/origin/HEAD"],
            text=True, stderr=subprocess.DEVNULL,
        ).strip()
        return ref.rsplit("/", 1)[-1]
    except subprocess.CalledProcessError:
        return "main"


def cmd_default_branch():
    print(default_branch())
    return 0


def cmd_pr_link(branch):
    try:
        url = subprocess.check_output(
            ["git", "remote", "get-url", "origin"], text=True
        ).strip()
    except subprocess.CalledProcessError:
        print("No 'origin' remote configured", file=sys.stderr)
        return 1

    m = re.match(r"(?:git@|https://)([^:/]+)[:/](.+?)(?:\.git)?/?$", url)
    if not m:
        print(f"Could not parse remote URL: {url}", file=sys.stderr)
        return 1
    host, path = m.group(1), m.group(2)
    base = default_branch()

    if "github" in host:
        print(f"https://{host}/{path}/compare/{base}...{branch}?expand=1")
    elif "gitlab" in host:
        print(
            f"https://{host}/{path}/-/merge_requests/new"
            f"?merge_request%5Bsource_branch%5D={branch}"
            f"&merge_request%5Btarget_branch%5D={base}"
        )
    else:
        print(f"https://{host}/{path}/compare/{base}...{branch}")
    return 0


def main(argv):
    if not argv:
        print(__doc__)
        return 1
    cmd, rest = argv[0], argv[1:]
    if cmd == "next" and len(rest) == 1:
        return cmd_next(rest[0])
    if cmd == "next" and len(rest) == 3 and rest[1] == "--after":
        try:
            after = int(rest[2])
        except ValueError:
            print(f"--after expects a line number, got {rest[2]!r}", file=sys.stderr)
            return 1
        return cmd_next(rest[0], after)
    if cmd == "slug" and rest:
        return cmd_slug(rest)
    if cmd == "checkoff" and len(rest) == 2:
        return cmd_checkoff(rest[0], rest[1])
    if cmd == "uncheck" and len(rest) == 2:
        return cmd_uncheck(rest[0], rest[1])
    if cmd == "add-context" and len(rest) >= 3:
        return cmd_add_context(rest[0], rest[1], " ".join(rest[2:]))
    if cmd == "default-branch" and not rest:
        return cmd_default_branch()
    if cmd == "pr-link" and len(rest) == 1:
        return cmd_pr_link(rest[0])
    print(f"Bad invocation: {argv}\n\n{__doc__}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
