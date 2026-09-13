# pi-dev-config
Configuration files for pi.dev agent

## Extensions

### Agent modes

The `agent-modes` extension bundles the policies that govern how autonomously the agent behaves: which built-in tools are available, whether git write commands (commit/push/merge/rebase/reset --hard/tag) are allowed, and a system prompt snippet describing the mode's behavior.
It is configured through the `/mode` command.

Three modes are built in.
Pair mode blocks file edits and git writes so the agent designs and discusses with the user rather than acting unilaterally.
Auto mode is fully autonomous, with edits and git writes unrestricted.
Coordinator mode also blocks edits and git writes for the main agent directly, and instructs it to delegate implementation work to subagents, escalate any subagent questions to the user instead of guessing, and default to self-doubt over confidently asserting an answer itself.

In coordinator mode, the extension also renders a live status widget tracking delegated subagent tasks (running/done/failed, with elapsed time), built on the same tool-call data the `subagent` extension's session store uses.

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

## Skills

### Project memory

`skills/project-memory/SKILL.md` explains how to use the `project-memory` extension's tools (`memory_search`, `memory_get`, `memory_write`, `memory_update`, `memory_promote`, `memory_delete`) to save and recall durable, project-scoped facts and decisions across sessions.
Use it when deciding whether something is worth remembering for next time, checking what has already been remembered before asking the user again, or when the user asks to remember something, check notes, or mentions project memory directly.

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
