# Analysis Guide

Concrete things to look for in the extracted data, and how to turn each into
a recommendation. Work through these in order of likely impact.

## 1. Exact repeated requests (`aggregate.exact_repeated_user_requests`)

This is the cheapest, highest-confidence redundancy signal: the user typed
essentially the same instruction more than once (possibly in different
sessions/projects). For each entry with `count >= 2`:

- If it's a generic instruction ("run the tests", "commit this", "write a
  commit message") -> suggest a shell alias, a pi slash-command, or adding it
  to a project's `AGENTS.md`/`CLAUDE.md` so the agent does it proactively.
- If it's a domain-specific recurring task (e.g. "check for redundant Go
  imports", "summarize the diff before committing") -> suggest turning it
  into a **skill** with a script, so the agent auto-detects the pattern next
  time.
- If it's a correction/nag ("stop doing X", "always do Y first") repeated
  across sessions -> the instruction isn't sticking. Suggest putting it in
  project/global instructions (`AGENTS.md`, `~/.pi/agent/settings.json`
  system prompt additions) rather than relying on re-typing it.

## 2. Repeated verbatim bash commands (`aggregate.top_bash_commands_verbatim`)

Commands that recur identically across sessions indicate manual work that
could be automated:

- Repeated `cd X && grep/sed/cat ...` exploration commands -> the user/agent
  is manually navigating the same codebase paths. Suggest a small script or
  a skill that encodes the lookup (e.g. "find where X is defined").
- Repeated environment setup (`export PATH=...`, `source .venv/bin/activate`,
  a hardcoded `GODIR=...` path) -> suggest a shell profile addition, a
  `direnv` `.envrc`, or a Makefile/justfile target instead of retyping it.
- Repeated git workflows (same sequence of `git add`/`commit`/`push` flags)
  -> suggest a git alias.

## 3. Tool-usage shape (`aggregate.tool_usage_counts`, per-session `tool_call_counts`)

- High `bash` count relative to `read`/`edit` may mean the agent is using
  `cat`/`sed`/`grep` via bash instead of the dedicated `read` tool - not
  necessarily bad, but worth flagging if it correlates with more errors or
  slower sessions.
- A high ratio of `edit` calls to distinct files edited suggests
  trial-and-error edits (multiple attempts to get one file right) - look at
  `tool_errors` for that file/session to see if edits were failing and
  retried.

## 4. File churn (`most_read_files`, `most_written_files`, `most_edited_files`)

- Files read very frequently across sessions are probably files the agent
  should already "know about" - candidates for a project `AGENTS.md` summary
  or a skill reference doc, so the agent doesn't need to re-read them from
  scratch each session.
- Files edited many times in short succession within one session may
  indicate an unclear spec or repeated back-and-forth - check
  `assistant_text_samples` and `user_messages` for that session to see if
  requirements kept changing.

## 5. Errors (`common_errors`, per-session `tool_errors`)

- Recurring identical errors across sessions (same command, same failure)
  are pure waste - the same mistake is being made repeatedly. Suggest a
  guard: a pre-flight check, a corrected command alias, or a note in
  `AGENTS.md` warning the agent away from the failing pattern.
- Bash exit-code failures clustered around one program -> check if it's a
  missing dependency, wrong working directory, or wrong invocation syntax
  that recurs.

## 6. Cost/token/time trends (`usage_totals`, `duration_seconds`, `total_cost_usd`, `total_tokens`)

- Compare cost/tokens per session over time (sort per-session data by
  `started`) to see if sessions are getting more expensive/longer - could
  indicate growing codebase complexity, or the agent re-reading the same
  context repeatedly without the user compacting.
- High `compactions` count in a single session may mean the task was too
  large for one session and should have been split, or that available
  context/tooling isn't summarizing efficiently.

## 7. Model usage (`models_used`)

- Frequent `model_change` events within single sessions may indicate the
  user is manually working around model limitations (e.g. switching to a
  bigger model after a smaller one struggled) - worth naming as a pattern
  ("you switch from qwen3:8b to a larger model N times after tool-call
  failures").

## Synthesizing the report

For each finding, state:
1. **What** the pattern is, with a number (count/frequency) and a concrete
   quoted example.
2. **Why** it's costing the user (time retyping, tokens/cost, error-prone
   repetition, context not reused).
3. **A specific fix** - alias, skill, `AGENTS.md`/`CLAUDE.md` snippet,
   settings.json change, or workflow change - not just "be more efficient".

Prefer fewer, well-evidenced findings over an exhaustive list of every count
in the JSON.
