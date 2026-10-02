# Report Schema

Output of `scripts/extract_costs.py`. All costs are USD; all prices are USD
per 1M tokens.

## `meta`

| Field | Meaning |
|---|---|
| `generated_at` | when the report was produced |
| `sessions_analyzed` | session files successfully parsed |
| `first_activity` / `last_activity` | ISO bounds of the analyzed window |
| `window` | `{after, before}` from `--after` / `--before`; entries outside it are dropped |
| `catalog_models_priced` | how many models had prices in models-store.json |

## `totals`

| Field | Meaning |
|---|---|
| `cost_usd` | summed provider-reported cost - the real number |
| `turns` / `paid_turns` / `free_turns` | assistant turns; free = zero-cost (local/ollama) |
| `tokens` | summed `input`, `output`, `cacheRead`, `cacheWrite`, `cacheWrite1h`, `reasoning`, `totalTokens` |
| `cost_by_component` | dollars attributable to each of input/output/cacheRead/cacheWrite |
| `cost_share_by_component` | the same as fractions of total - **the first thing to look at** |
| `avg_cost_per_paid_turn` | mean cost of a billed assistant turn |
| `avg_cost_per_session` | mean cost per session |
| `blended_usd_per_mtok` | total cost / total billable tokens, in $/Mtok |
| `cache.read_share_of_context` | cacheRead / (input + cacheRead + cacheWrite); high is good |
| `cache.write_amortization` | cacheRead / cacheWrite - how many times each cached token was read back. Below ~1.25 means the cache-write premium wasn't repaid |

## `by_model`

One row per `provider/model` actually used, sorted by spend:

| Field | Meaning |
|---|---|
| `turns`, `sessions`, `cost_usd`, `share_of_spend` | volume and spend |
| `tokens`, `cost_by_component` | the same breakdowns, scoped to this model |
| `avg_cost_per_turn` | mean billed cost per turn on this model |
| `effective_usd_per_mtok` | what you actually paid per million tokens **including** the cheap cache reads. Comparing this between two providers of the *same* model exposes caching differences, not list-price differences |
| `catalog_price_per_mtok` | list prices from the catalog, or `null` if unpriced (local models) |

## `by_project`, `by_day`

`by_project`: per-cwd sessions, turns, cost, `cost_per_session`, and the model
mix used there. `by_day`: date, cost, sessions, turns, tokens - use for trend
lines and for spotting a single expensive day.

## `most_expensive_sessions`

Ranked sessions with `cost_usd`, `turns`, `duration_seconds`, models used,
`peak_context_tokens`, and `cache_write_amortization`. Use it to pick which
session to re-extract with per-session detail.

## `tool_output_cost_attribution`

Per tool, how much its output cost you *after* it was produced:

| Field | Meaning |
|---|---|
| `results`, `error_results` | how many tool results, how many failed |
| `total_result_chars`, `est_result_tokens`, `avg_result_tokens` | output volume (tokens estimated at 4 chars/token) |
| `est_carried_tokens` | result tokens x the number of later assistant turns that had to keep carrying them in context |
| `est_carry_cost_usd` | those carried tokens priced at the session's dominant cacheRead rate |

`est_carry_cost_usd` is an **estimate**, not a billed figure: it uses a
chars/4 token approximation and assumes the result stayed in context for the
rest of the session (compaction can cut it short). Use it to rank tools
against each other, not as an exact charge.

## `sessions` (omitted with `--no-per-session`)

Per session: identity (`file`, `session_id`, `cwd`, `started`, `ended`,
`duration_seconds`), `turns`/`paid_turns`/`free_turns`, `model_changes`,
`compactions`, `stop_reasons`, `cost_usd`, `cost_by_component`, `tokens`,
`cost_per_turn` (mean/median/max), `cache`, and `per_model`.

With turn series enabled it also has:
- `turn_series`: `{turn, timestamp, model, context_tokens, output, reasoning, cost}`
  per assistant turn. `context_tokens` = input + cacheRead + cacheWrite, i.e.
  the context actually paid for on that turn.
- `context_growth`: first/last/peak context tokens and mean cost of the first
  vs last quarter of turns - the cheapest way to see a session getting heavier.

## `repricing`

| Field | Meaning |
|---|---|
| `paid_token_profile` | the token mix of paid turns only |
| `actual_cost_usd` | what that profile really cost |
| `candidates` | catalog models with `cost_usd`, `delta_usd`, `delta_pct`, `price_per_mtok`, `context_window`, cheapest first, plus the most expensive few for contrast |
| `caveat` | the honesty constraint - repeat it to the user |

---

# Join Report Schema

Output of `~/.pi/agent/skills/shared/exchange_costs.py`, the layer shared with
`session-insights`. The unit is an **exchange**: one user message plus every
assistant turn and tool call it triggered, up to the next user message. Costs
are summed from provider-reported `usage.cost`, so they are real charges.

## `meta`, `totals`

`exchanges`, `sessions`, `min_repeats`; then `cost_usd`, `assistant_turns`,
`avg_cost_per_exchange`, `median_cost_per_exchange`. The median is often far
below the mean - free local turns and one-line follow-ups sit at the bottom,
a few long exchanges at the top. Quote both.

## `repeated_request_costs`

Identical requests (normalized: lowercased, punctuation stripped) clustered
and priced. Per cluster: `count`, `example`, `total_cost_usd`,
`avg_cost_usd`, `share_of_spend`, `assistant_turns`, `sessions`, `projects`,
`models`, `tools`, and `mean_position`.

This is the direct upgrade to `session-insights`' `exact_repeated_user_requests`:
same clusters, now ranked by money rather than by count. Automate the
expensive ones first.

## `expensive_exchanges`

The priciest individual requests: `cost_usd`, `assistant_turns`, `position`,
`request` text, `tool_calls`, `tools`, `tool_errors`, `models`. Use it to
answer "what was I doing when this got expensive".

## `error_costs`

`exchanges_with_errors` / `exchanges_total`, `cost_of_those_exchanges_usd`,
`share_of_spend`, `top_errors` (each with `occurrences`,
`attributed_cost_usd`, `example_request`), plus
`largest_exchange_cost_usd` and `largest_exchange_share_of_error_cost`.

Read the last two before quoting the share: if one long exchange contributes
most of the error cost, the error didn't cause the cost, it merely co-occurred
with it. The whole section is an upper bound on what fixing the failures saves.

## `tool_mix_costs`

Spend grouped by the *set* of tools an exchange used: `tools`, `exchanges`,
`assistant_turns`, `cost_usd`, `avg_cost_per_exchange`. High
`avg_cost_per_exchange` on a mix like `bash,edit,write` usually means
long build/fix loops rather than an expensive tool.

## `model_routing`

Per repeated cluster: `example`, `count`, `total_cost_usd`, `models`, and
`already_partly_free` (true if any turns ran on a local/zero-cost provider).
A cluster that is repeated, expensive, and *not* already partly free is the
best candidate for routing to a cheaper or local model.

## Position caveat (applies to every section)

Exchange cost includes re-sending all context accumulated before it. Later
exchanges therefore cost more regardless of the request. `mean_position` /
`position` (0 = session start, 1 = session end) is reported everywhere so the
claim can be checked: expensive **and early** is about the request; expensive
**and late** is usually about session length.

---

# Content Report Schema

Output of `~/.pi/agent/skills/shared/content_costs.py`. Attributes each turn's real input-side cost (input + cacheRead + cacheWrite) to the content that filled the context window.

Method, in short:
For every assistant turn, the script rebuilds the context sent to the model (branch path, latest compaction, `context_edit`, system-message replay).
It splits that context into **segments** (one file read, one AGENTS.md, one skill description, one tool declaration, one message block).
Segments new since the previous turn on the branch take the write cost (input + cacheWrite), capped at their scaled size.
Carried segments take the cacheRead cost plus any leftover write cost (cache misses).
Estimated token counts decide shares only within a turn, so dollars reconcile to actual spend.

## `meta`

`sessions`, `assistant_turns`, `chars_per_token`, `thinking_in_context`, `classifier` (`pygments` or `regex-fallback`), `path_glob`.
`calibration` holds `median`, `p10`, `p90` of actual context tokens / estimated tokens per paid turn.
A narrow spread means the segment model tracks what was sent, so shares are reliable.
A median well above 1 (around 1.7 is normal) means chars/4 undercounts and message framing is unmodeled; it rescales token counts but not shares.

## `totals`

`input_side_cost_usd`, `attributed_cost_usd` (should equal it), `unattributed_cost_usd` (should be ~0), `output_cost_usd_not_attributed`.
Generated output is not attributed; once it is in context its carry cost shows up under `conversation/*`.

## Common row fields

Every ranked row has `cost_usd`, `share_of_input_side`, `first_send_cost_usd`, `carry_cost_usd`, `est_tokens_sent`, `est_token_turns` (tokens x turns in context), `segments`, `sessions`.
`carry_cost_usd` far above `first_send_cost_usd` means the content was cheap to send but sat in context for a long time.

## `by_category`, `top_labels`

Categories:

| Category                           | Content                                                      |
|------------------------------------|--------------------------------------------------------------|
| `file/read`                        | `read` tool results, keyed by path                           |
| `file/bash`                        | Part of a bash result attributed to a file it printed        |
| `file/edit`, `file/write`          | File content sent by the agent in edit/write call arguments  |
| `bash`                             | Other bash output; label = first command name (`git`, `rg`)  |
| `toolcall`, `tool`, `tool_error`   | Other tool call arguments, results, and failed results       |
| `conversation/*`                   | User text, assistant text, prior thinking, user `!` commands |
| `system/tool_decl`                 | One tool's JSON declaration                                  |
| `system/agents_md`                 | One `<project_instructions>` file                            |
| `system/skill`                     | One skill's `<skill>` description block                      |
| `system/section`                   | Remaining prompt sections (`rules`, `docs`, `tools`, ...)    |
| `custom`, `compaction/*`, `edited` | Extension messages, summaries, context-edit replacements     |

`top_labels` ranks `[category, label]` pairs.

## `always_loaded`

The `system/*` rows with `avg_est_tokens_per_turn`.
These are paid on every turn of every session, so a small per-turn size still adds up.

## `files`

Per path: common fields plus `reads_by_kind` (read/bash/edit/write counts), `avg_turns_in_context`, `cost_by_content_class` (`content`, `comment`, `docstring`, `blank`, `license`, `unclassified`), `comment_cost_usd` (comment + docstring + license), `approx_attributed_cost_usd`, `redundant_reads`, `redundant_read_cost_usd`, `projects`.
`approx_attributed_cost_usd` is the part from multi-file bash commands, where output was split across files by current on-disk size.

## `directories`, `extensions`

Same rows grouped by parent directory and file extension.
These and `files`/`comments` respect `--path-glob`.

## `comments`

- `files_shown_to_model` - comment-class mix of read and bash file content, with `cost_classified_from_current_disk_copy_usd` (the part classified from the file as it is now rather than the logged text).
- `files_written_by_agent` - the same mix for edit/write arguments. A high comment share here points at the agent's writing style, not the codebase.
- `top_files_by_comment_cost` - `path`, `comment_cost_usd`, `cost_usd`, `comment_share`.

Classification is by weighted characters (whitespace runs collapsed) per line via pygments; a top-of-file comment block mentioning copyright/license/SPDX is `license`.

## `redundant_reads`

Files re-read with the same range while the earlier copy was still in context and the file had not been edited in between.

## `whatif_upper_bounds`

`strip_comments_docstrings_from_reads_usd`, `strip_license_headers_from_reads_usd`, `avoid_redundant_rereads_usd`.
Ceilings holding everything else fixed.

## Caveats

- Bash file attribution parses the command string (`cat`, `sed`, `head`, `tail`, `nl`, `bat`, `git show REV:path`, with `cd` tracking). Files printed by scripts or other commands stay under `bash`.
- Assumes prefix caching: carried content is served from cache, new content is written.
- Images are counted at a flat 1500 tokens.

## Ledger: `metrics.json` (`shared/usage_ledger.py`)

One per report dir under `~/notes/pi-usage/<date>/`.

| Field | Meaning |
|---|---|
| `window` | `{after, before}` - the half-open window this report covers; the next report starts at `before` |
| `previous_report` | dir name of the report this one is compared against |
| `metrics` | comparable headline numbers; keys and better-direction are in `METRICS` in `usage_ledger.py` |
| `model_share` | `{provider/model: share_of_spend}`; a model missing from a report had 0% share |
| `categories` | `{category: {sessions, active_hours, cost_usd}}`, filled by `usage_ledger.py categorize` |

`changes.jsonl` (one JSON object per line) holds `id`, `title`, `detail`, `metrics` (keys, optionally `=up`/`=down`), `expect`, `status` (proposed, applied, kept, reverted, dropped), `baseline_report` (the latest report when the change was applied), and `history`.
