---
name: codebase-tour
description: Runs a guided, read-only walkthrough of a codebase using the codebase-tour extension's tools (tour_plan, tour_advance, tour_note, tour_show, tour_status, tour_end). Use this when the user asks for a tour, walkthrough, or onboarding to a codebase, wants help understanding how a project is structured, or runs /tour start. Teaching style is mixed Socratic/explain-first, one stop at a time.
---

# Codebase Tour

A codebase tour is a short, ordered sequence of stops through a codebase,
each one explained and checked before moving to the next.
The point is to build the user's mental model of the codebase, not to dump
information.

If a tour is already in progress, its status (topic, style, every stop, and
which one is current) is injected into your context automatically each turn
as a hidden message - you do not need to call `tour_status` just to see
where things stand.
Resume at the current stop rather than restarting, unless the user asks for
a fresh tour.

## Planning a tour

1. Explore the codebase first: read the README, skim the directory
   structure, and look at the files relevant to the requested topic (or, for
   a general tour, the overall architecture).
   Don't call `tour_plan` before you actually know what's there.
2. Draft 4-8 stops, ordered so each one builds on the last (e.g. entry
   point, then core abstractions, then the more specialized pieces).
   A stop is a title, a one- or two-sentence summary of what it covers and
   why it matters, the relevant file paths, and (when there's a specific
   snippet worth showing) one or two tight anchors - a file plus a line
   range, aimed at a single function or block, not a whole file.
3. Call `tour_plan` once with the full list.
   Calling it again later replaces the plan (the old tour is archived, never
   deleted) - use this if the user redirects the tour, not for small
   corrections to one stop.
4. Call `tour_advance` to move to stop 1, then present it.

## Showing code

`tour_advance` automatically shows a stop's first anchor as a snippet
alongside the stop, and records it as the tour's current "focus" - you don't
need to separately open the file yourself just to show it.
If a stop has more than one anchor, the rest are listed (not auto-shown) in
`tour_status` and the injected context - use `tour_show` to actually display
one of them when the discussion gets there.
Use `tour_show` for an ad hoc look at a file or line range mid-discussion
(e.g. the user asks "where's that defined?") without moving to a different
stop; it sets the same focus.
The current focus is visible to the user in a persistent location widget and
to you in the hidden per-turn status, so both of you stay oriented even
across a few turns of discussion; `/tour where` reports it on demand.
The widget is optional - the user can turn it off with `/tour pane off` (and
back on with `/tour pane on`, or check it with `/tour pane status`) - so
don't assume it's visible; the hidden per-turn status always reflects the
current focus regardless of this setting.

## The teaching loop (mixed Socratic/explain-first)

For each stop, do both of these, not just one:

- **Explain first**: describe what the code at this stop does and why it's
  shaped that way - the actual reasoning, not just a restatement of what the
  code says. Point at specific files/functions so the user can look while
  you talk.
- **Check with a question**: after explaining, ask something short that
  invites the user to predict, compare, or explore - not a trivia quiz.
  Good examples: "given that, what do you think happens if X fails
  partway through?", "want to guess how Y is enforced before I show you?",
  "does this match how you'd have built it?".

Balance the mix based on the user's signals, per stop:

- Short answers, "just tell me", or a request to speed up -> lean more
  explain-first; still ask an occasional lighter check-in, don't drop
  questions entirely.
- Detailed answers, follow-up questions, or requests to slow down -> lean
  more Socratic; ask before explaining, let the user attempt an answer
  first.
- Default to a balanced mix when you don't have a clear signal yet.

Move to the next stop with `tour_advance` once the user seems ready (they
answered, said "next"/"continue", or asked to move on) - don't advance out
from under a question they're still working through.

## Deep dives stay inline

If a stop's discussion turns into a deeper dive (the user asks "why" a few
levels down, or wants to trace a call path), follow it there in the
conversation rather than spinning it into a separate document.
Once the deep dive wraps up, call `tour_note` with a short breadcrumb (one
line: what was looked at, what was found) so it's not lost if the tour is
resumed in a later session, then return to the stop or advance.

## Read-only

A tour is read-only: don't edit files or make commits while touring, even
if you notice something worth fixing.
If the user wants an actual change made, say so plainly and suggest
switching modes (e.g. `/mode pair --session` or `/mode auto --session`) to
make it, then resume the tour afterward if they want to continue.

`/tour start` switches to tour mode for the current session only (it does
not change the user's persisted default mode for future sessions or
projects).
If the `agent-modes` extension isn't available, `/tour start` says so
directly instead of silently running a tour that isn't actually read-only -
treat that warning as a signal to be extra careful about not editing or
committing, since the usual enforcement isn't active.

## Ending a tour

Call `tour_end` once every stop has been covered (or the user wants to
stop early) - it archives the tour with an inferred or explicit outcome
(`completed` or `abandoned`).
The user can also do this directly with `/tour end`, or check on things
with `/tour status`, `/tour list`, `/tour where`, and `/tour pane`, without
involving you.
