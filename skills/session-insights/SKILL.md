---
name: session-insights
description: Analyzes past pi.dev session transcripts (~/.pi/agent/sessions) to surface behavioral trends and patterns in how the user interacts with the LLM - repeated requests, redundant tool-call patterns, recurring bash commands, frequently touched files, common errors, and wasted effort. Use when the user asks to review their pi sessions, find redundancy in how they work with the agent, get usage stats/trends, or wants recommendations (skills/aliases/extensions/prompt habits) to reduce repetitive work.
---

# Session Insights

Extracts structured data from pi.dev session JSONL logs and turns it into an
evidence-based report on interaction trends, redundancy, and improvement
opportunities. The heavy parsing/counting is done by a script (deterministic,
cheap); the LLM does the qualitative interpretation on top of that data.

## Step 1: Decide scope

Ask yourself (or the user, if ambiguous):
- **project**: sessions for the current project only (default, `--scope project --cwd <dir>`)
- **all**: every pi session across all projects (`--scope all`) - better for
  finding general habits/redundancy that aren't project-specific
- Time window: use `--since N` (days) to limit to recent activity if the user
  cares about "lately" rather than all-time.

## Step 2: Run the extractor

```bash
python3 scripts/extract_sessions.py --scope all --since 30 --out /tmp/session_report.json
```

Useful flags:
- `--scope {project,all}` (default `project`)
- `--cwd PATH` (project dir to match, default is cwd; only for `--scope project`)
- `--since DAYS` limit to sessions modified in the last N days
- `--limit N` only the N most recent session files
- `--max-text-len N` truncate long text fields (default 400 chars) - lower this
  if the aggregate is too large to fit in context
- `--no-per-session` aggregate-only output (much smaller; start here for large histories)
- `--out PATH` write to a file instead of stdout (recommended - then `read` it,
  optionally with `offset`/`limit`, instead of dumping huge JSON into the
  conversation at once)

**Recommended workflow for large histories:** first run with `--no-per-session`
to get the aggregate cheaply and see the scale of things. If you need
concrete quotes/examples of specific redundant requests, re-run without that
flag (optionally narrowed with `--since`/`--limit`) and read specific sections.

The script does **no interpretation** - it only counts and extracts. All
fields are documented in the script's docstring and in
`references/report-schema.md`.

## Step 3: Interpret the data

Read `references/analysis-guide.md` for the specific things to look for
(redundant requests, tool-usage inefficiencies, repeated errors, file churn,
cost/token trends) and how to turn each into an actionable recommendation.

## Step 4: Report back

Produce a concise report with:
1. **Headline stats** - sessions analyzed, total cost/tokens, time span.
2. **Top trends/patterns** - ranked by frequency/impact, each with 1-2 concrete
   examples pulled from the data (quote actual user text or commands).
3. **Redundancy findings** - specific repeated asks or repeated tool patterns,
   with a suggested fix (e.g., "you asked X 6 times across sessions -> turn
   this into a `/skill:` or a saved prompt template").
4. **Concrete next actions** - things like: a shell alias, a pi extension, a
   skill, a CLAUDE.md/AGENTS.md addition, a settings.json tweak, or a change
   in how the user phrases requests. Prefer 3-6 high-impact suggestions over
   an exhaustive list.

Do not just dump the raw counts back at the user - synthesize them into
insight and recommendations.

## Combining with cost-analysis

`session-insights` finds what the user keeps doing; `cost-analysis` finds
where the money goes. Neither alone answers **"which of my habits is
expensive?"** - and that is the question that decides what to fix first.

When the user cares about cost as well as habits (or when a redundancy
finding needs to be prioritized), run the join:

```bash
python3 "$HOME/.pi/agent/skills/shared/exchange_costs.py" --scope all --out /tmp/exchange_costs.json
```

It prices **exchanges** - one user request plus every assistant turn and tool
call it triggered - so each pattern this skill surfaces can be quoted with a
dollar figure:

- `repeated_request_costs` - the `exact_repeated_user_requests` clusters from
  this skill, with what they actually cost. A cluster repeated 6 times for
  $0.02 total is not worth automating; the same count for $2.40 is.
- `error_costs` - what exchanges containing failed tool calls cost, feeding
  the `common_errors` section here.
- `tool_mix_costs` - which combinations of tools show up in expensive
  exchanges, feeding the tool-usage analysis here.
- `model_routing` - which models ran each repeated cluster, and whether any of
  it already runs free locally. This is what turns "you ask this a lot" into
  "route this to the local model".

Read `~/.pi/agent/skills/cost-analysis/references/optimization-playbook.md`
before interpreting the dollar figures - especially the warning that later
exchanges cost more purely because they carry more context, which is why
every section reports `mean_position`.
