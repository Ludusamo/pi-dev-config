---
name: project-memory
description: Explains how to use the project-memory extension's tools (memory_search, memory_get, memory_write, memory_update, memory_promote, memory_delete) to save and recall durable, project-scoped facts and decisions across sessions. Use this any time you're deciding whether something is worth remembering for next time, want to check what's already been remembered before asking the user again, or the user asks to "remember this", "check your notes", or mentions project memory directly.
---

# Project Memory

A compact index of active project memory is already injected into your
context every turn (as a hidden message) - you do not need to call a tool
just to see what exists. It looks like this:

```
Project memory index (use memory_get <id> for full details):
Long-term:
- auth-flow-decision-a1b2c3 (active): Auth flow uses short-lived JWTs [auth, security]
Short-term:
- current-refactor-notes-d4e5f6: Notes on the in-progress payment refactor
```

Use the index to decide whether to look something up. Use `memory_get <id>`
to read the full body of an entry the index only summarizes. Use
`memory_search` when you want to check for something that might exist but
isn't obviously named in the index, or to filter by tag.

If no index is shown at all, project memory is disabled (mode `off`) or, in
repo mode, the project isn't trusted yet - don't keep calling memory tools in
that case, they will just report unavailability.

## Short-term vs. long-term

- **Short-term**: scratch context for the task at hand - notes, in-progress
  decisions, things that matter for the next few sessions but not forever.
  Saved immediately via `memory_write` with `term: "short"`, and expires
  automatically (archived, not deleted) after about two weeks.
- **Long-term**: durable, broadly useful facts worth keeping indefinitely -
  architectural decisions, stable conventions, hard-won gotchas. Saving one
  requires human approval: if there's an interactive UI you'll be asked to
  confirm; without one, the entry is saved as `pending` for a human to
  review later instead of being treated as active. Don't assume a long-term
  write you just made is immediately active - check the tool's response.

When something you saved short-term turns out to matter long-term, use
`memory_promote` instead of writing a new long-term entry from scratch - it
carries the content over and marks the original as archived with a pointer
to the promoted entry.
Promotion assigns the long-term entry a new id (never reuses the short-term
id), so use the id in the tool's response for any later `memory_get` or
`memory_update` calls on the promoted entry.
Only active short-term entries can be promoted.

Approval for long-term memory isn't just a one-time gate at write time.
`memory_update` requires the same approval before changing a long-term
entry's title/body or setting its status to `active`: with an interactive UI
you'll be asked to confirm, and a decline leaves the entry unchanged; without
one, the change is deferred by saving it as `pending` instead of taking
effect immediately.
Declining a `memory_write` or `memory_promote` confirmation means nothing is
saved at all - it does not fall back to saving as pending.
Saving as pending only happens when there's no interactive UI to ask.

## When to write

Write when you learn something that would save real time if a future
session (yours or someone else's) had it up front: a non-obvious decision
and its reasoning, a constraint that isn't visible in the code, a dead end
someone doesn't need to hit again. Don't write things that are already
obvious from reading the code or git history, and don't write pure task
tracking that belongs in a todo list instead.

## Deleting

`memory_delete` archives an entry (sets its status to `archived`) - it does
not remove the file. There is no hard delete; archived entries just drop out
of the compact index and default search results. If an entry needs a human
to look at it again rather than being treated as archived, use
`memory_update` to set its status to `needs-review` instead.

## Storage mode and subagents

Where memory is stored (private to you, committed in the repo, a custom
path, or disabled) is controlled by `/memory-mode` - view the current mode
with `/memory-mode` (no args), or set it with
`/memory-mode <private|repo|custom|off> [path]`. Repo mode commits a marker
file so a team shares the setting, and requires the project to be trusted.

For a git repo, private/custom memory is keyed by name: the repo's remote name (`origin` if configured, otherwise the first remote git reports), or its folder name if it has no remote (shown by `/memory-mode`).
A plain, non-git directory is keyed by its folder name.
This means every worktree of a repo shares memory, and separate clones or forks that happen to share a name share memory too - that's intentional, not something to work around.
The memory-mode setting itself (private/repo/custom/off, and any custom path) is keyed the same way, so same-named projects share that too, not just the memory content.

Because identity is name-based, this has a real security implication: private mode has no trust gate, so any directory - including an untrusted checkout - whose remote or folder name sanitizes to an existing project's key gets full read/write access to that project's private memory with no prompt at all.
Be mindful of this when working in an untrusted checkout, especially one whose name you don't recognize as genuinely new.

If you need to merge an old key's memory into the current one (for example after a repo was renamed, or to consolidate memory from before this naming scheme), use `/memory-relink <oldKey|oldPath>`, or `/memory-relink key:<name>` to look up a literal key by name even if a same-named local file or directory would otherwise be picked up instead.
If the old key doesn't look like a leftover legacy id - i.e. it looks like it could be another project's current, live key - relinking will ask for confirmation first (or, without an interactive UI, require `/memory-relink ... --force`) before moving anything, so a mistyped path can't silently drain another project's memory into this one.

If you're running as a pi-runtime subagent (a child `pi` process with
`PI_SUBAGENT=1` set), only `memory_search` and `memory_get` are available to
you - writing, updating, promoting, and deleting memory is reserved for the
main agent so a burst of parallel subagents can't race each other writing
conflicting notes. Read what's there; report back what should be remembered
and let the main agent decide whether to save it.
Direct write/edit tool calls into the memory store are blocked by the
extension itself, so that protection always applies.
Bash commands that literally mention the memory path are also blocked, but
that check is a best-effort guard rather than a sandbox - don't rely on it as
a security boundary if you're a subagent looking for a way around it; the
intended path is always to report findings back to the main agent instead.
Claude-runtime subagents are a different case entirely: they run outside the
pi extension system, so they have no memory tools at all and none of this
guard applies to them - there's no pi process loading the extension to
enforce it.
