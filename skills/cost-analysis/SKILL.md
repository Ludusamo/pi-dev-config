---
name: cost-analysis
description: Analyzes spend across pi.dev sessions (~/.pi/agent/sessions) to answer "where is my money going" and "how do I spend less for the same work" - cost by model/provider/project/day, cache efficiency, context-growth and tool-output carry cost, most expensive sessions, and counterfactual repricing against the model catalog. Use when the user asks what they are spending on models, why a session was expensive, whether to switch model or provider, how to cut token/API cost, or wants a cost report or budget breakdown.
---

# Cost Analysis

Turns pi's per-turn usage accounting into a spend report and a set of
cost-reduction recommendations. A script does the deterministic summing and
ranking; the LLM interprets the result and proposes changes.

Related but different: `session-insights` looks at *behavioral* redundancy
(repeated asks, repeated commands). This skill looks at *money*. If the user
wants both, run this one first - the spend numbers tell you which behavioral
patterns are worth fixing.

## Where the numbers come from

Every assistant message in a session JSONL carries provider-reported cost:

```json
"usage": {"input":2,"output":141,"cacheRead":0,"cacheWrite":5440,"totalTokens":5583,
          "cost":{"input":4e-06,"output":0.00141,"cacheRead":0,"cacheWrite":0.0136,"total":0.015014}}
```

These are actual charges, not estimates - report them as such. Catalog prices
in `~/.pi/agent/models-store.json` (USD per 1M tokens) are used only for
counterfactuals and cache-carry estimates. Local providers (ollama) report
zero cost and are counted separately as "free turns" so they don't dilute
paid averages.

## Step 1: Run the extractor

```bash
python3 scripts/extract_costs.py --scope all --no-per-session --out /tmp/cost.json
```

Flags:
- `--scope {all,project}` (default `all`; `project` uses `--cwd PATH`)
- `--since DAYS` / `--limit N` - narrow the window
- `--top N` - length of ranked lists (default 15)
- `--reprice "opus,gpt-5,gemini"` - restrict counterfactual candidates to matching models
- `--no-per-session` - aggregates only; **start here**, it is small
- `--no-turn-series` - keep per-session rows but drop per-turn detail
- `--out PATH` - write to a file and read it back rather than dumping JSON into context

Workflow: run with `--no-per-session` first. Only re-run with per-session
data when you need to explain *why* one specific session was expensive.

Field-by-field meanings are in `references/report-schema.md`.

## Step 2: Interpret

Read `references/optimization-playbook.md`. It covers, in rough order of
payoff: component mix (what fraction of spend is cache reads vs output),
cache amortization, context growth within long sessions, tool-output carry
cost, provider arbitrage for the same model, model right-sizing, and how to
reprice honestly.

Two rules that keep the analysis truthful:

1. **Never present repricing as guaranteed savings.** The counterfactual holds
   the token profile fixed; a cheaper model that needs more turns or retries
   can cost more. Say "upper bound" and mean it.
2. **Anchor every recommendation to a dollar figure from the data.** "Use a
   smaller model for X" is worth nothing without "X was $N of your $M".

## Step 2b: Attach the spend to behavior (optional but usually worth it)

The steps above say *where* money went. They don't say *what the user did* to
spend it. To connect the two, run the join that both this skill and
`session-insights` share:

```bash
python3 "$HOME/.pi/agent/skills/shared/exchange_costs.py" --scope all --out /tmp/exchange_costs.json
```

It segments sessions into **exchanges** (one user request plus its whole cost
tail) and reports `repeated_request_costs`, `expensive_exchanges`,
`error_costs`, `tool_mix_costs`, and `model_routing`. Schema in
`references/report-schema.md`.

Use it whenever the user asks *why* something was expensive, or wants to know
what to change rather than just what it cost. Two guards on reading it:

- Every section reports `mean_position` / `position` (0 = session start,
  1 = session end). Exchange cost includes re-sending all prior context, so
  late exchanges are expensive regardless of what was asked. An expensive
  cluster that is also **early** is a real finding; one that is always late is
  mostly a symptom of session length - report it that way.
- `error_costs.largest_exchange_share_of_error_cost` near 1 means a single
  long exchange that happened to contain an error is carrying the whole
  number. Say that instead of quoting the headline share.

If the user wants the behavioral side in full (repeated phrasings, repeated
commands, file churn), run `session-insights` too and merge the narratives:
spend figures rank the findings, behavior explains them.

## Step 3: Report

Structure the answer as:

1. **Headline** - total spend, window covered, sessions/turns, blended $/Mtok,
   and the single biggest line item.
2. **Where it goes** - breakdown by model, project, and cost component, with
   shares. Call out anything surprising (one session dominating, an expensive
   component the user probably didn't know about).
3. **Efficiency findings** - cache amortization, context growth, tool-output
   carry cost, provider deltas. Each with the number that proves it.
4. **Recommendations** - 3-6, each with estimated $ or % impact and the
   concrete change (settings.json edit, workflow habit, skill, model choice).
   Rank by impact, and be explicit when an estimate is soft.

Do not dump the JSON back at the user. If they want an artifact-style
dashboard rather than a terminal summary, offer it - the report JSON has
everything a chart needs (`by_day`, `by_model`, `turn_series`).
