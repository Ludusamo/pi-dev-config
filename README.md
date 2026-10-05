# pi-dev-config
Configuration files for pi.dev agent

## Extensions

### Agent modes

The `agent-modes` extension bundles the policies that govern how autonomously the agent behaves: which built-in tools are available, whether git write commands (commit/push/merge/rebase/reset --hard/tag) are allowed, and a system prompt snippet describing the mode's behavior.
It is configured through the `/mode` command; add `--session` (e.g. `/mode tour --session`) to switch for the current session only, without changing the persisted default used by future sessions/projects.

Five modes are built in.
Pair mode is design-first: the user drives design decisions and the agent helps them think rather than deciding for them.
The agent asks for the user's approach first on each new problem, explains concepts directly, and leaves consequential decisions open.
Work moves through three checkpoints, Understanding, Design and Implementation, and only advances with the user's explicit confirmation.
Before design confirmation only short illustrative snippets (roughly 15 lines or fewer each) are allowed, and full implementation code waits until the design is confirmed, after which it may be shown in chat for review.
Details the user did not decide are listed as a Detail | Proposal | Why it matters table.
Pair mode blocks built-in edit/write and git writes, and the agent must not work around that with bash redirects, `sed -i`, `tee`, heredocs, `git apply` and the like.
Confirmed changes are applied by delegating to the `worker` subagent (after the user says yes), by the user switching with `/mode guarded --session` or `/mode auto --session`, or by the user editing themselves.
Guarded mode sits between pair and auto: the agent can investigate and plan autonomously, but edit/write tool calls and git write commands require confirmation first.
Auto mode is fully autonomous, with edits and git writes unrestricted.
Coordinator mode also blocks edits and git writes for the main agent directly, and instructs it to delegate implementation work to subagents, escalate any subagent questions to the user instead of guessing, and default to self-doubt over confidently asserting an answer itself.
Tour mode also blocks edits and git writes, and is meant to be paired with the `codebase-tour` extension: it guides the agent to run a read-only, mixed Socratic/explain-first walkthrough of the codebase using that extension's tools, instead of narrating a tour from memory with no way to resume it later.

In pair, guarded and auto modes, the injected snippet also suggests the `scout` subagent for broad read-only lookups and the `reviewer` subagent for a second opinion, but only for agents that actually exist.
In pair mode it also offers to dispatch the `worker` subagent with the agreed design once the user has confirmed it, and only dispatches after the user says yes.
In pair mode it adds that subagents do not override the mode, so none should edit files until the user has confirmed the design and asked for it to be applied.
When a prompt explicitly asks for a devil's advocate (or to poke holes or argue against something) or to dispatch a worker, a hidden hint for that one turn suggests the matching subagent.
Worker requests must be phrased as an instruction naming the subagent ("use a worker subagent", "use the `worker` agent") or as delegation ("dispatch this to a worker"), so questions, mentions, or ordinary coding requests about workers ("have the worker retry") do not fire.
A request is ignored only when a negation sits right before the trigger ("don't use a worker", "no devil's advocate needed"), and the worker hint is dropped in tour mode.
Neither the suggestions nor the hints are injected inside subagents.

Pair mode adapts to the user through saved pair preferences, which are global across all projects and persist across sessions in `~/.pi/agent/agent-modes-pair-preferences.json`.
Saved preferences (at most 20, each at most 200 characters) are injected into the pair prompt, and the user's current instructions always override them.
The agent can propose a stable collaboration-style preference with the `pair_preference` tool, which works only in pair mode and always asks the user to confirm, so nothing is saved without an interactive UI or if declined.
The `/pair-prefs` command manages them directly with `list`, `add <text>`, `remove <id>` and `clear`.
Typed `list`, `add` and `remove` need no confirmation, while `clear` asks first.

In coordinator mode, the extension also renders a live status widget tracking delegated subagent tasks (running/done/failed, with elapsed time), built on the same tool-call data the `subagent` extension's session store uses.

Pi-runtime subagents (`PI_SUBAGENT=1`) never adopt the persisted mode, which would block a worker's edits under pair, tour or coordinator.
They run in a dedicated subagent mode instead: edits are allowed (each agent's `tools:` list decides what it can touch), and git writes are allowed only when the dispatching session is in auto or coordinator mode, otherwise blocked, since a subagent has no UI to confirm with.
The parent passes its mode to children through `PI_PARENT_AGENT_MODE`.

### Ask user

The `ask-user` extension registers an `ask_user` tool that lets the LLM ask the user a clarifying question instead of guessing, optionally offering candidate answers alongside free-text input.
It is meant for situations where the agent is uncertain about requirements, scope, or a decision and guessing would risk wasted work.

### Footer layout

The `footer-layout` extension replaces the built-in two-line footer with a custom layout.
The first line shows cost and token/status info on the left and the current working directory plus git branch on the right.
The second line shows mode, model, and effort.
Extension status lines set via `ctx.ui.setStatus` are preserved below, unchanged, and the mode value is read from the `agent-modes` extension's footer status entry rather than importing it directly.

### Subagent

The `subagent` extension delegates tasks to specialized agents running in either the `pi` or `claude` CLI, each with an isolated context window.
Agents are markdown files with YAML frontmatter, discovered from `~/.pi/agent/agents` (user scope) and `.pi/agents` (project scope), with a `runtime` field selecting which CLI runs them.

It supports several dispatch modes: single (one-shot), parallel (concurrent one-shot tasks), chain (sequential one-shot tasks that pass results forward), and a persistent open/send/close flow for multi-turn work against the same accumulated context, such as an iterative code review.
Each invocation spawns a short-lived child process; persistence across open/send calls comes from the underlying CLI's own session/resume mechanism, not a long-running daemon.

Subagent runs use `--no-session`, so their turns never appear in a session file.
Their cost is only recorded in the parent's `subagent` tool result, and the cost-analysis extractors read it from there (`subagents` in their report).

Four user-scope agents live in `agents/`.
Models were picked by benchmarking candidates on tasks with known answers (2026-10-02, details in `~/pi-artifacts/pi-usage/agent-bench-2026-10-02.md`):

| Agent    | Model                                | Tools                    | Why                                                                                               |
|----------|--------------------------------------|--------------------------|---------------------------------------------------------------------------------------------------|
| scout    | `openai/gpt-5.6-luna:low`            | read-only + memory read  | Full marks on both lookup tasks at $0.006-0.018, 4-13x cheaper than Sonnet 5.5 for the same answers |
| planner  | `openai/gpt-5.6-sol:high`            | read-only + memory read  | Matched Opus 5.5 and Fable 5.1 (found a prior ADR that rejected the feature) at 57% / 26% of their cost |
| worker   | `anthropic/claude-sonnet-5.5:medium` | read/edit/write/bash     | Passed every hidden test on both tasks and flagged a subtle float-ordering change; about 40% of Opus's cost |
| reviewer | `anthropic/claude-opus-5.5:high`     | read-only + memory read  | Only model to catch all three real issues on a 2,800-line change; expensive there (about $3)        |

### Project memory

The `project-memory` extension gives the agent durable, project-scoped memory that persists across sessions.
A companion skill (`skills/project-memory/SKILL.md`) explains when and how to use it.

Storage is configurable via `/memory-mode [private|repo|custom|off] [path]`, and defaults to private (stored under `~/.pi/agent/memory`, outside the repo).
Repo mode commits a marker file (`.pi/memory.json`) so a team shares the setting, and only takes effect once the project is trusted.
Worktrees of the same repository share private/custom memory; separate clones do not.

Entries are short-term (TTL'd scratch notes, written immediately) or long-term (durable facts, which need user approval or are saved as pending for review).
Nothing is ever hard-deleted: TTL expiry and `memory_delete` both archive an entry in place.
A compact index of active entries is injected into context automatically each turn; full entry bodies are fetched on demand with `memory_get`.

Only the main agent can write memory.
This protection applies to pi-runtime subagents only (spawned as a child `pi` process with `PI_SUBAGENT=1`), which get read-only access (`memory_search` and `memory_get`) so parallel subagents can't race each other writing conflicting notes.
Their built-in write/edit tool calls are blocked from touching the memory store; this is enforced by the extension itself, so it always applies.
Bash commands that literally mention the resolved memory path are also blocked, but this is best-effort only: a subagent that can run bash can still reach the memory store through indirection the string checks don't catch (environment-variable expansion, `cd` plus a relative path, and similar obfuscation).
Claude-runtime subagents (`runtime: claude`) run entirely outside the pi extension system: they have no memory tools at all, and none of this pathguard protection applies to them, since there's no pi process loading the extension to enforce it.

### Codebase tour

The `codebase-tour` extension gives the agent a structured way to run a guided walkthrough of a codebase: an ordered list of "stops" (`tour_plan`), moved through one at a time (`tour_advance`), with short inline breadcrumbs from any deep dive taken along the way (`tour_note`) rather than separate documents.
A companion skill (`skills/codebase-tour/SKILL.md`) explains the mixed Socratic/explain-first teaching loop; the `agent-modes` extension's `tour` mode makes the walkthrough read-only.

Storage is private, under `~/.pi/agent/tours/<projectKey>/`, keyed by the same project identity `project-memory` uses (see that extension's notes on naming) so both land under a matching key with no extra configuration.
There is at most one active tour per project; starting a new one (`tour_plan`, or `/tour start`) archives whatever was active first - nothing is ever deleted, only moved into that project's `history/` folder.
The active tour's status (topic, style, every stop, and which one is current) is injected into context automatically each turn, so a session can resume a tour without an extra tool call, and `/tour status`, `/tour list`, and `/tour end [completed|abandoned]` manage it directly from the user side without involving the model.

A stop can carry tight "anchors" (a file plus an optional line range, relative to the project root) pointing at the specific snippet it's about, set via `tour_plan` or added ad hoc with `tour_show`; a stop's second and later anchors (only the first is auto-shown as a snippet) still show up in `tour_status`/`tour_advance` output and, for the current stop, the injected context.
`tour_advance` reads a stop's first anchor and shows it alongside the stop, and records it as the tour's current "focus"; `tour_show` shows an arbitrary file/range and sets the focus directly without moving stops.
The focus is surfaced two ways: a persistent location widget above the editor in UI-capable modes (`ctx.ui.setWidget`, guarded by `ctx.hasUI` - TUI and RPC, not print/json, refreshed on session start, every turn, and whenever a tour tool or `/tour` command changes it), and a line in the same hidden per-turn context the tour status uses, so the model stays oriented too.
`/tour where` reports (and refreshes) the current focus on demand.
The widget is optional and on by default; `/tour pane on|off|toggle|status` turns it off (clearing it immediately and keeping it from being recreated) or back on, persisting the choice per project alongside the tour itself.
The hidden per-turn context is unaffected by this setting either way, so the model stays oriented even with the widget off; the setting itself has no effect outside UI-capable modes like print/json, where there is no widget to show.
Snippet reads are bounded (a capped file size checked via `stat` before reading, a capped number of lines, capped line width), confined to the project root (the repo's toplevel when cwd is inside a git repo, so anchors still resolve correctly when a session resumes from a subdirectory), and sanitized to strip ANSI/control characters before being shown - and never throw, so a missing, oversized, or out-of-range-anchored file comes back as a plain error message instead of failing the tool call.
In the TUI, `tour_advance` and `tour_show` also render a syntax-highlighted snippet panel for their result, built on top of the same plain-text snippet used everywhere else.

Read-only enforcement lives entirely in `agent-modes`' `tour` mode (blocked edits/git-writes, same switch used by pair/coordinator), not in this extension - the tools themselves work in any mode, so planning or reviewing a tour doesn't require switching modes first.
`/tour start` switches to `tour` mode automatically (it dispatches `/mode tour --session` the same way a typed slash command would), so read-only enforcement is already active by the time the walkthrough begins; no separate `/mode tour` step is needed.
The `--session` flag matters here: without it, starting a tour would silently change the persisted default mode for every future session and project, not just this one.
If the `agent-modes` extension isn't loaded (so `/mode` isn't available), `/tour start` warns the user instead of silently proceeding as if the walkthrough were read-only.

### Usage changes log

`usage-ledger.ts` adds `/usage`, for marking the recommendations from pi usage checks without knowing where the ledger script lives.
`/usage` opens a picker: choose a change, then what happened (done, done since a date, keep, revert, drop) and an optional note.
Shortcuts: `/usage done C2 [note]`, `/usage keep|revert|drop C1 [note]`, `/usage list [all]`, and `/usage check` to have the agent run a usage check now.
It wraps `skills/shared/usage_ledger.py change list/set`; the log itself is `~/pi-artifacts/pi-usage/changes.jsonl`.
You rarely need it: the agent marks a change applied when it implements one, and each usage check first looks for evidence of proposed changes and asks about the ones it cannot see.

## Skills

### Project memory

`skills/project-memory/SKILL.md` explains how to use the `project-memory` extension's tools (`memory_search`, `memory_get`, `memory_write`, `memory_update`, `memory_promote`, `memory_delete`) to save and recall durable, project-scoped facts and decisions across sessions.
Use it when deciding whether something is worth remembering for next time, checking what has already been remembered before asking the user again, or when the user asks to remember something, check notes, or mentions project memory directly.

### Codebase tour

`skills/codebase-tour/SKILL.md` explains how to run a guided walkthrough with the `codebase-tour` extension's tools (`tour_plan`, `tour_advance`, `tour_note`, `tour_show`, `tour_status`, `tour_end`): explore first, plan 4-8 ordered stops with a tight anchor where there's a specific snippet worth showing, then teach each one with a mixed Socratic/explain-first loop (explain what the code does and why, then ask a short question before moving on), keeping any deep dive inline as a short recorded note rather than a separate document.
Use it when the user asks for a tour, walkthrough, or onboarding to a codebase, or runs `/tour start`.

### Cost analysis

`skills/cost-analysis/SKILL.md` analyzes spend across pi.dev sessions to answer where money is going and how to spend less for the same work: cost by model/provider/project/day, cache efficiency, context-growth and tool-output carry cost, most expensive sessions, and counterfactual repricing against the model catalog.
A script does the deterministic summing and ranking; the LLM interprets the result and proposes changes.

### Session insights

`skills/session-insights/SKILL.md` analyzes past pi.dev session transcripts to surface behavioral trends and patterns in how the user interacts with the LLM: repeated requests, redundant tool-call patterns, recurring bash commands, frequently touched files, common errors, and wasted effort.
A script does the deterministic parsing and counting; the LLM does the qualitative interpretation on top of that data.

### Todo pairing

`skills/todo-pairing/SKILL.md` works through a project's plain-text `todo.md` checklist together with the user, one task at a time, in a live session.
It uses the same worktree/branch/PR mechanics as todo-runner, but replaces every skip or bail-out decision with a direct question to the user, since someone is actually there to answer.

### Todo runner

`skills/todo-runner/SKILL.md` runs one task from a project's plain-text `todo.md` checklist unattended: it picks the first unchecked box, implements it in an isolated git worktree, pushes the branch, checks the box off on the main branch, and hands back a PR link.
Because nobody is watching while it runs, it skips ambiguous tasks or bails out cleanly when blocked, rather than guessing.

Both todo skills share helper scripts in `skills/shared` (`todo_helper.py`, `pi_sessions.py`, `exchange_costs.py`), which is not itself a skill.
