---
name: todo-runner
description: Runs one task from a project's plain-text todo.md checklist, unattended — picks the first unchecked box, implements it in an isolated git worktree, pushes the branch, checks the box off on the main branch, and hands back a PR link. Use this any time a scheduled or background pi run mentions checking a todo file, working the next item off a backlog overnight, "do the next todo", or picking up from a checklist with no one watching — even if the user doesn't name this skill directly. Also use it for a manual one-off "grab the next task from todo.md and do it" request. If the user is actually present and wants to work through tasks together live, answering questions as they come up, use todo-pairing instead.
---

# Todo Runner

Picks exactly one task off a plain-text checklist and does it, without a
human in the loop. Because nobody's watching while it runs, the whole
design is built around leaving a clean, reviewable trail rather than
being clever: one task, one branch, one pushed commit, one checked box,
one link to look at in the morning.

Do all of this for the current project — this skill acts on the repo
you're already in, not a list of projects. That repo's *main* worktree
specifically, though: step 0 locates it even if the session happens to
have started somewhere else, like a linked worktree.

## The todo file

Look for `todo.md` at the project root; if it's not there, try `TODO.md`.
If neither exists, say so and stop — don't create one unprompted.

`todo.md` is very likely gitignored — a plain-text scratch list doesn't
belong in commit history — which makes it a local file that lives only
in the main worktree's directory. `git worktree add` in step 4 will NOT
carry it into the ephemeral worktree the way tracked files are. Step 0
resolves it to an absolute path once; use that path (never a bare
`todo.md`/`TODO.md`) for every `todo_helper.py` call for the rest of
the run, no matter which directory the shell is currently in.

Format is plain markdown checkboxes. A task can optionally have extra
context indented directly underneath it — acceptance criteria, links,
constraints, anything that wouldn't fit on one line — as plain indented
text or nested bullets:

```markdown
- [ ] Add rate limiting to the /login endpoint
  - Use a sliding window, not fixed bucket
  - Limit is 5 attempts per minute per IP
  - See src/middleware/throttle.js for the existing pattern
- [x] Set up CI pipeline
```

When a task gets skipped instead of completed (steps 2 and 5 below), a
`- **CONTEXT NEEDED:** ...` bullet gets added under it explaining why —
so the reason lives in the file itself for whoever looks at it next,
not just in a run's report that scrolled away:

```markdown
- [ ] Rework the auth system
  - **CONTEXT NEEDED:** ambiguous — rework how? adding SSO, replacing
    the session store, or something else? name the specific change.
```

`todo_helper.py` does the mechanical parts of this workflow — finding
the task (and any context beneath it), slugifying it, flipping a
checkbox, adding a context bullet, working out a compare-URL — so a
checkbox never gets mis-parsed or the wrong line flipped at 3am. Reach
for it rather than hand-editing the checklist or hand-parsing the git
remote.

The script ships with the skills, not with the project: it's a single
copy shared with todo-pairing, sitting in the global skills install at
`~/.pi/agent/skills/shared/todo_helper.py`. Don't go looking for it in
the project repo — it won't be there. Step 0 pins the absolute path
once as `$HELPER`, and every call below uses that.

## Workflow

**0. Locate the main worktree, sync it to the default branch, and locate the todo file.**
The session may already be sitting in some *other* worktree of this
repo — a feature branch someone's mid-way through, not the main
checkout — rather than the project root itself. Find the actual main
worktree first, from wherever you happen to be, and move there before
touching any branch:
```
MAIN_WORKTREE=$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')
cd "$MAIN_WORKTREE"
```
`git worktree list` always lists the main worktree first regardless of
which worktree you run it from, so this resolves correctly even when
the session started inside a linked worktree. Doing this before the
branch sync matters: if you `git checkout "$BASE"` from inside a linked
worktree that isn't `$BASE`'s own checkout, and `$BASE` is already
checked out in the main worktree, git refuses outright (a branch can't
be checked out in two worktrees at once) — that's very likely the error
that sent you here in the first place.

Now sync up and locate the todo file:
```
HELPER="$HOME/.pi/agent/skills/shared/todo_helper.py"
BASE=$(python3 "$HELPER" default-branch)
git checkout "$BASE" 2>/dev/null || git checkout -b "$BASE" --track "origin/$BASE"
git pull origin "$BASE"
TODO="$MAIN_WORKTREE/todo.md"
[ -f "$TODO" ] || TODO="$MAIN_WORKTREE/TODO.md"
```
If neither file exists, say so and stop — don't create one unprompted.
Keep `$MAIN_WORKTREE` and `$TODO` around for the rest of the run; every
later step that touches the todo file uses `$TODO`, not a relative
path, and every later `cd` back out of the ephemeral worktree goes to
`$MAIN_WORKTREE`.

If `cd "$MAIN_WORKTREE"` itself fails, or file access there is refused,
that's not something this skill can work around — the session's
permissions are confined to the worktree it started in. Stop and tell
the user plainly: re-run this from a session rooted at (or with access
to) `$MAIN_WORKTREE`, rather than one scoped to a linked worktree.

**1. Find the next task.**
```
python3 "$HELPER" next "$TODO"
```
Prints `<line number>\t<task text>` for the first `- [ ]` line, top to
bottom — order in the file is the priority order — followed by any
indented context lines found directly beneath it, verbatim. Exits 1
with no output if every box is checked; if that happens, report that
the list is clear and stop, there's nothing else to do this run.

**2. Sanity-check the task before committing to it.**
Weigh the task text together with any context lines printed beneath it
— a one-liner that looks ambiguous alone ("rework the auth system") is
often exactly what a person meant to leave unattended if the context
underneath pins down the scope. Only when the task is still too
ambiguous or too large to implement confidently, even accounting for
its context, should you decline it — don't force it. Record exactly
what's missing and move on:
```
python3 "$HELPER" add-context "$TODO" <line number> "<specific, actionable ask>"
python3 "$HELPER" next "$TODO" --after <line number>
```
Skip the `add-context` call if the printed context already has an
unanswered `CONTEXT NEEDED` bullet for this exact gap — don't pile on a
duplicate; only add one if you have something new or more specific to
say than what's already there. Write the ask as something a human can
act on directly ("name the specific change: SSO, session-store swap, or
something else?"), not a restatement that it was too vague. Note the
line number, task text, and reason in a running skip list for the final
report too, then re-run this sanity check on whatever `next --after`
returns. Keep going in file order until either a task passes the check
or `next --after` exits 1 (no more unchecked tasks) — in which case
report every skip and stop, there's nothing viable this run. Skipped
tasks stay unchecked and in their original position, since a later run
(or a human) may still pick them up — now with the context bullet
telling them what to add.

**3. Claim the task.**
Before doing any work, check the box off in `$TODO`. This claims the
task up front, so a checked box always means "in progress or done,"
never "picked but silently abandoned":
```
python3 "$HELPER" checkoff "$TODO" <line number>
```
This is a plain local file edit, not a git commit — `todo.md` is
gitignored, so there's nothing to add or push. It's still an effective
claim against another run on the same machine, since both would be
reading and writing the same file on disk; it just doesn't extend to
another machine or clone, which wouldn't see this file at all.

**4. Set up an isolated worktree.**
Do the work somewhere that can't collide with anything else touching
this repo, branching off the `$BASE` you already synced to in step 0:
```
git fetch origin
SLUG=$(python3 "$HELPER" slug <task text>)
BRANCH="todo/$SLUG"
git worktree add -b "$BRANCH" "../$(basename "$MAIN_WORKTREE")-wt-$SLUG" "origin/$BASE"
```
Then `cd` into that new directory for the rest of the work.

**5. Implement the task.**
Normal engineering judgment applies here — this is the one part of the
workflow that isn't mechanical. Treat any context lines from step 1 as
the spec: constraints, acceptance criteria, and pointers to existing
patterns named there aren't optional flavor text. If the project has a
test suite or build command, run it before moving on; unattended work
that hasn't been checked against the existing tests is a much bigger
ask of the person reading it in the morning.

Sometimes a task only reveals it's out of reach once you're partway in —
missing credentials or access, a requirement that contradicts what's
actually in the codebase, a design decision that genuinely needs a
human. If that happens, don't push a half-finished attempt to make
progress look real. Bail out cleanly, then unclaim the task — the box
you checked in step 3 no longer reflects reality:
```
cd "$MAIN_WORKTREE"
git worktree remove "../$(basename "$MAIN_WORKTREE")-wt-$SLUG"
python3 "$HELPER" uncheck "$TODO" <line number>
python3 "$HELPER" add-context "$TODO" <line number> "<specifically what's blocking it and what would unblock it>"
```
Both are plain local edits, no git involved. Be concrete in the context
bullet — "blocked: needs the STRIPE_API_KEY env var, not present in
this environment" is useful, "got stuck" is not. Add the task to the
same skip list from step 2 with a reason, then go back to step 1's
lookup using `next "$TODO" --after <this task's line number>` to try
the next candidate.

**6. Commit and push the branch.**
Commit with a message that names the task, then push:
```
git add -A
git commit -m "<task text>"
git push -u origin "$BRANCH"
```
Don't open a pull request — just push the branch. The final report will
include a link for the user to open the PR themselves when they're ready.

**7. Get the PR link.**
```
python3 "$HELPER" pr-link "$BRANCH"
```
Builds a compare/merge-request URL from the `origin` remote (handles
GitHub and GitLab; falls back to a generic compare URL for anything
else).

**8. Clean up the worktree.**
```
cd "$MAIN_WORKTREE"
git worktree remove "../$(basename "$MAIN_WORKTREE")-wt-$SLUG"
```
Note: `git worktree remove` doesn't accept `-q` — passing it is an error,
not a no-op. The box is already checked from step 3, so there's nothing
further to do to `$TODO` on a successful run.

**9. Report back.**
End with a short summary: which task was done, the PR link, and
anything notable from implementing it (tests run, anything skipped). If
any tasks were skipped or bailed on along the way (steps 2 and 5), list
each one with its line number and reason — the same detail now also
sits in `$TODO` as a `CONTEXT NEEDED` bullet, so the report is a recap,
not the only record of it. If nothing was viable this run, lead with
that instead of a completed task.

## Boundaries

- One *completed* task per run — but you may pass over tasks that look
  too ambiguous, oversized, or turn out to be blocked mid-implementation,
  trying the next one in line rather than stopping the whole run cold.
  Skipping always moves forward in file order; never jump ahead because
  a later task merely looks easier, and never act twice on the same
  task in one run. If more throughput is wanted, schedule this to run
  more than once a night rather than looping harder within one run.
- Never force-push, and never push the feature branch anywhere but its
  own name (step 6) — the only thing that goes near the default branch
  is `$BASE` itself being read and fast-forward-pulled in step 0, never
  written to directly.
- Never touch `$TODO` outside of the one task currently under
  consideration — its checkbox (`checkoff`/`uncheck`) and its context
  bullets (`add-context`) only, never a hand edit, and always by its
  resolved `$TODO` path, never a bare `todo.md` typed after a `cd`.
  Skipping a task (step 2) or bailing on one (step 5) can add a
  `CONTEXT NEEDED` bullet under it, but never flips its checkbox unless
  it was actually claimed first.
- Don't merge, close, or delete branches — the branch and the PR link
  are the handoff to the user.
- If `git fetch`, the worktree add, or the branch push fails, stop and
  report the failure plainly rather than retrying with `--force` or
  working around it some other way.
- Claiming a task before doing the work means a checked box can outlive
  an interrupted run — if this process is killed or crashes after step
  3 but before step 5's bail-out or step 8's cleanup, the box is left
  checked in `$TODO` with no branch or PR to show for it. That state
  needs a human (or a future run) to notice and uncheck it; this skill
  doesn't try to detect or repair it on its own.
