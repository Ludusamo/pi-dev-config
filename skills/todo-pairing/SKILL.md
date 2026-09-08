---
name: todo-pairing
description: Works through a project's plain-text todo.md checklist together with the user in a live session, one task at a time — same worktree/branch/PR mechanics as todo-runner, but replaces every "skip it" or "bail out" decision with a direct question to the user, since someone's actually there to answer. Use this when the user wants to sit down and go through the todo list together, pair on backlog items live, or work through todos interactively — as opposed to an unattended overnight run (see todo-runner for that).
---

# Todo Pairing

The live counterpart to todo-runner. Same todo file, same
`todo_helper.py` mechanics (next/checkoff/uncheck/add-context/
slug/pr-link/default-branch), same one-task-in-its-own-worktree-and-
branch shape — but built around a human actually being present. Where
todo-runner skips an ambiguous task or bails out cleanly when blocked
because nobody's watching, this skill asks instead. Don't silently skip
or bail here — that's the wrong instinct for a live session.

`todo_helper.py` ships with the skills, not the project: it's a single
copy shared with todo-runner, sitting in the global skills install at
`~/.pi/agent/skills/shared/todo_helper.py`, never in the project repo.
Step 0 pins that absolute path once as `$HELPER`, and every call below
uses it.

Do all of this for the current project's *main* worktree, same as
todo-runner — step 0 finds it even if the session started somewhere
else, like a linked worktree.

## The todo file

Same file and format as todo-runner: `todo.md` (or `TODO.md`) at the
project root, plain markdown checkboxes, optional indented context
underneath a task, and `CONTEXT NEEDED` bullets either skill may have
left behind. If a task already carries one from a prior unattended run,
that's your opening question — lead with it:

```markdown
- [ ] Rework the auth system
  - **CONTEXT NEEDED:** ambiguous — rework how? adding SSO, replacing
    the session store, or something else? name the specific change.
```

## Workflow

**0. Locate the main worktree, sync it to the default branch, and locate the todo file.**
Identical to todo-runner:
```
MAIN_WORKTREE=$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')
cd "$MAIN_WORKTREE"
HELPER="$HOME/.pi/agent/skills/shared/todo_helper.py"
BASE=$(python3 "$HELPER" default-branch)
git checkout "$BASE" 2>/dev/null || git checkout -b "$BASE" --track "origin/$BASE"
git pull origin "$BASE"
TODO="$MAIN_WORKTREE/todo.md"
[ -f "$TODO" ] || TODO="$MAIN_WORKTREE/TODO.md"
```
If neither todo file exists, say so and ask whether to create one —
unlike todo-runner, there's someone here to answer that.

**1. Find the next task, or let the user pick.**
```
python3 "$HELPER" next "$TODO"
```
Defaults to the next unchecked item, top to bottom — but if the user
wants to jump to a specific item instead, that's fine here. File order
is a default worth following, not a rule to enforce on someone actively
steering the session.

**2. Confirm scope with the user before starting — don't guess.**
Present the task and any context (including an existing
`CONTEXT NEEDED` bullet) and ask whatever's needed to pin down scope.
This replaces todo-runner's skip-if-ambiguous step entirely: there's no
such thing as "too ambiguous to attempt" here, only "haven't asked yet."
Once it's clear, if the clarification is worth keeping for later (an
unattended run, or your own memory next week), fold it in:
```
python3 "$HELPER" add-context "$TODO" <line number> "<the clarification, as a standing fact about the task>"
```
Optional, and only for detail worth persisting — not required just to
proceed.

**3. Set up an isolated worktree.**
Same as todo-runner, branching off the `$BASE` synced in step 0:
```
git fetch origin
SLUG=$(python3 "$HELPER" slug <task text>)
BRANCH="todo/$SLUG"
git worktree add -b "$BRANCH" "../$(basename "$MAIN_WORKTREE")-wt-$SLUG" "origin/$BASE"
```
Then `cd` into that new directory for the rest of the work.

**4. Implement the task, together.**
Normal engineering judgment, with the user right there to weigh in.
The moment something would have triggered todo-runner's bail-out —
missing credentials, a requirement that contradicts the codebase, a
design decision — stop and ask instead of working around it or
abandoning the task. That's the entire reason this variant exists. If
the project has a test suite or build command, run it before moving on.

**5. Commit and push the branch.**
```
git add -A
git commit -m "<task text>"
git push -u origin "$BRANCH"
```

**6. Hand off the change.**
```
python3 "$HELPER" pr-link "$BRANCH"
```
Ask whether the user wants just the link, or wants the PR actually
opened now (e.g. `gh pr create`) since they're here to review or merge
it themselves right away. Either is fine — follow their preference
rather than defaulting silently.

**7. Clean up the worktree.**
```
cd "$MAIN_WORKTREE"
git worktree remove "../$(basename "$MAIN_WORKTREE")-wt-$SLUG"
```
Note: `git worktree remove` doesn't accept `-q` — passing it is an
error, not a no-op.

**8. Check the box off.**
Only once the task is actually done, pushed, and handed off:
```
python3 "$HELPER" checkoff "$TODO" <line number>
```
A plain local edit, same as todo-runner — `todo.md` is gitignored, so
there's nothing to add or push.

**9. Ask what's next.**
Unlike todo-runner's fixed one-task-per-run, there's no arbitrary cap
here — ask the user whether to keep going with the next task or stop
for now. Let them set the pace.

## Boundaries

- Never skip or bail on your own judgment call — that's todo-runner's
  job, and it works differently precisely because nobody's watching
  there. Here, always ask.
- Still one task at a time, each in its own worktree and branch — don't
  start a second task's worktree before the current one is cleaned up.
- Never force-push, never touch any line in `$TODO` besides the current
  task's own checkbox and context, and never merge, close, or delete a
  branch unless the user explicitly asks.
- If `git fetch`, the worktree add, or a push fails, stop and report
  the failure plainly — same as todo-runner, this isn't a case for
  `--force` or working around it.
