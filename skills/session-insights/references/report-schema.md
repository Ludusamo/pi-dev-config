# Report Schema

Output of `scripts/extract_sessions.py` is JSON with two top-level keys.

## `aggregate` (always present)

| Field | Meaning |
|---|---|
| `total_sessions` | number of session files successfully parsed |
| `total_cost_usd` | summed assistant-message cost across sessions |
| `total_tokens` | summed total tokens across sessions |
| `total_duration_hours` | sum of (last_ts - first_ts) per session, in hours |
| `tool_usage_counts` | `{toolName: count}` across all sessions |
| `top_bash_programs` | `{program: count}` - first word of each bash command (e.g. `grep`, `sed`, `go`) |
| `top_bash_commands_verbatim` | `{full_command: count}` - exact repeated commands (strong redundancy signal) |
| `most_read_files` | `{path: count}` via the `read` tool |
| `most_written_files` | `{path: count}` via the `write` tool |
| `most_edited_files` | `{path: count}` via the `edit` tool |
| `models_used` | `{"provider/model": count}` of `model_change` events |
| `common_errors` | `{"toolName: error snippet": count}` - recurring failures |
| `exact_repeated_user_requests` | list of `{count, example, sessions}` for user messages whose normalized text (lowercased, punctuation stripped, whitespace collapsed) is byte-identical across turns/sessions - the strongest, cheapest redundancy signal |

## `sessions` (omitted if `--no-per-session`)

List of per-session objects:

| Field | Meaning |
|---|---|
| `file` | path to the jsonl file |
| `session_id` | session UUID |
| `cwd` | working directory when the session was created |
| `started` / `ended` | ISO timestamps of first/last entry |
| `duration_seconds` | wall-clock span of the session |
| `message_count` | count of `message`-type entries |
| `models_used` | models used within this session |
| `stop_reasons` | assistant stop reasons (`stop`, `length`, `toolUse`, `error`, `aborted`) |
| `compactions` / `branch_summaries` | counts of these event types |
| `usage_totals` | token/cost totals for this session |
| `tool_call_counts` | per-tool call counts for this session |
| `bash_commands` | list of every bash command run (verbatim, order preserved) |
| `files_read` / `files_written` / `files_edited` | sorted unique paths touched |
| `tool_errors` | list of `{toolName, error}` for failed tool results / nonzero exit codes |
| `user_messages` | list of `{id, timestamp, text, norm_hash}` - `norm_hash` is a hash of the normalized text, used for cross-session dedup |
| `assistant_text_samples` | up to 20 assistant text blocks (truncated), useful for eyeballing tone/topics |

Note: `norm_hash` catches only **exact** (post-normalization) duplicate
requests. Near-duplicates with different wording (e.g. "fix the failing test"
vs "the test is still failing, please fix it") are NOT automatically grouped -
look for these manually in `user_messages`/`bash_commands` when scanning
per-session data, since they're often the most actionable redundancy.
