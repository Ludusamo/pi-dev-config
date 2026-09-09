# Optimization Playbook

How to read the extracted numbers and turn them into recommendations, in
rough order of payoff. Every finding must carry a dollar figure from the data.

## 0. Understand what actually drives agent cost

In an agent session you are not billed once per question - you are billed once
per *turn*, and every turn re-sends the whole conversation so far. A session
with N turns pays for the context roughly N times (cheaply, via cache reads,
but N times nonetheless). So:

- **Output tokens are usually a minority of spend.** Context replay dominates.
- **What enters the context early is the most expensive thing in the session**,
  because it is carried by every later turn.
- **Session length is a cost multiplier**, not a cost addend.

Recommendations that only target "shorter answers" miss most of the money.

## 1. Component mix (`totals.cost_share_by_component`)

Start here; it decides which of the sections below matter.

- **cacheRead dominant (>40%)** - context replay is the bill. Go to sections
  3, 4, 5. Shorter sessions and smaller tool outputs are the lever.
- **cacheWrite large relative to cacheRead** - paying the ~1.25x write premium
  without reading it back. Go to section 2.
- **output dominant** - the model is producing a lot: long explanations, large
  file writes, heavy reasoning. Check `tokens.reasoning`; a high reasoning
  share suggests lowering `--thinking` for routine work.
- **input dominant** - unusual with caching on; typically means a provider or
  model without prompt caching. Worth naming explicitly.

## 2. Cache amortization (`totals.cache.write_amortization`, per-session `cache`)

`cacheRead / cacheWrite` is how many times each cached token was read back.
Cache writes cost ~1.25x normal input; reads cost ~0.1x. So:

- **> 5** - caching is working well; leave it alone.
- **~1-2** - marginal. Usually many short sessions, each paying to warm a
  cache it barely uses. Fix: fewer, longer sessions instead of restarting;
  use `--continue` / `--resume` rather than a fresh session per question.
- **< 1** - actively losing money on the cache. Look for churn early in the
  context (changing system prompt, files re-read with different content,
  frequent model switching - every `model_change` invalidates the cache).

Per-session `model_changes` is the tell for the last one: switching model
mid-session re-writes the whole cache at write prices.

## 3. Context growth within a session (`context_growth`, `turn_series`)

Compare `mean_cost_first_quarter` with `mean_cost_last_quarter`. A 3-5x rise
is normal; 10x+ means the session should have been split or compacted.

- `peak_context_tokens` near the model's context window - the session was
  running heavy for its whole tail. Every turn there is at its most expensive.
- Sessions with high `turns` **and** high `peak_context_tokens` are the top
  candidates for "should have been two sessions".
- Check `compactions`: zero compactions in a very long session means nothing
  ever shrank the context.

Recommendation shape: "session X spent $N over M turns; the last quarter of
turns averaged $A vs $B in the first quarter. Splitting it after the
<milestone> would have saved roughly $C."

## 4. Tool-output carry cost (`tool_output_cost_attribution`)

`est_carry_cost_usd` ranks tools by what their *output* cost across the rest
of the session. This is where "just run the command" habits show up: a tool
that returns 3k tokens on turn 5 of an 80-turn session is paid for ~75 times.

Typical findings and fixes:

- **`bash` at the top with a large `est_carried_tokens`** - unbounded command
  output. Fix: pipe through `head`, `wc -l`, `--quiet`, or write to a file and
  read only the part that matters. This is usually the single most actionable
  item.
- **`read` with a high `avg_result_tokens`** - whole files being read when a
  range would do. Fix: read with offset/limit, or grep first.
- **High `error_results`** - failed calls cost tokens twice: the error, then
  the retry. Cross-check `session-insights`' `common_errors` for the pattern.

Be explicit that these are estimates (chars/4, ignores compaction).

## 5. Provider arbitrage (`by_model.effective_usd_per_mtok`)

When the same model appears under two providers, compare
`effective_usd_per_mtok`, not list price. A large gap with identical
`catalog_price_per_mtok` means the providers differ in caching behaviour or
routing, not in price - which is a real, actionable finding: route work to the
cheaper path, or investigate why caching is worse on one.

Check the token mix before concluding: a provider used only for short sessions
will look worse simply because it never amortized its cache writes. Compare
sessions of similar length where possible, and say so if you can't.

## 6. Model right-sizing (`by_model`, `by_project`, `repricing`)

- Which models carry `share_of_spend`, and is that work actually hard? Look at
  the projects and session shapes behind the expensive model.
- `free_turns` shows how much is already running locally at zero cost. If a
  local model handles a real share of turns, the question is which *categories*
  of work could move there - mechanical edits, summarizing, commit messages -
  not whether to switch wholesale.
- `repricing.candidates` gives the ceiling on savings from switching. Use it
  to size the opportunity, then recommend a **split** ("route category X to the
  cheap model") rather than a blanket switch, unless the data supports more.
- Check `context_window` on candidates: a cheaper model that can't hold the
  session's `peak_context_tokens` will compact more and may cost more.

## 7. Turning findings into changes

Prefer recommendations the user can actually apply:

- `~/.pi/agent/settings.json` - `defaultModel` / `defaultProvider` for the
  common case.
- Per-invocation flags - `--model`, `--thinking low`, `--models` for cheap
  cycling on routine tasks.
- Habits - `--continue` instead of new sessions; splitting long sessions at
  natural boundaries; bounding bash output.
- Project `AGENTS.md` - a line telling the agent to bound command output or
  read files in ranges, so the fix persists without the user re-typing it.
- A skill or script for anything the user does repeatedly and expensively.

## Honesty constraints

- Provider-reported `cost` is real. `est_carry_cost_usd` and everything in
  `repricing` are estimates - label them.
- Repricing holds the token profile fixed. State it as an upper bound and note
  that a weaker model may need more turns.
- With few sessions, per-model averages are noisy. Say how many sessions and
  turns a claim rests on rather than implying a stable trend.
- Don't recommend a change whose saving is smaller than the effort it costs -
  name the ones that don't clear that bar and drop them.

## 8. Cost-weighted behavior (join with session-insights)

With `exchange_costs.py` output in hand, the recommendation list gets sharper
because each habit carries a price:

- **Rank redundancy by spend, not frequency.** `repeated_request_costs` sorted
  by `total_cost_usd` tells you which repeated ask is worth a skill, an alias,
  or an `AGENTS.md` line. Something repeated 8 times for $0.03 is noise.
- **Route by category, using evidence.** A cluster with high
  `total_cost_usd`, `already_partly_free: false`, and a mechanical-looking
  request (formatting, commit messages, summarizing) is the strongest possible
  case for sending that category to a local or cheaper model - you can name
  the request, the count, and the dollars.
- **Separate "expensive request" from "expensive position".** Check
  `mean_position` before blaming a request. A cluster at `mean_position` 0.9
  is expensive because of everything that came before it; the fix is session
  hygiene (section 3), not the request.
- **Price the error loops.** `error_costs.top_errors` ranks recurring failures
  by attributed dollars, but check `largest_exchange_share_of_error_cost`
  first - a single long exchange can carry the whole figure.
- **Read `tool_mix_costs` as workflow shapes.** The expensive mixes are
  usually edit/build/retry loops. That points at a project-level fix (a faster
  test command, a pre-flight check in `AGENTS.md`) rather than a model change.
