# Prompt: Cartographer

Produces `guide.md`, the orientation artifact a human reads before looking at the diff.

**Run this before `REVIEW_STANDARDS.md` is loaded into context.**
If rules are already in context, the map will be written around them and the human's first impression is no longer their own.

## Inputs

| Input           | Where it comes from                                          |
| --------------- | ------------------------------------------------------------ |
| `repo_path`     | `review_worktree.py` JSON `.repo_path`                       |
| `range`         | `.range`                                                     |
| `base_worktree` | `.worktrees.base`                                            |
| `head_worktree` | `.worktrees.head`                                            |
| `classify.json` | written by `classify.py`                                     |
| intent          | MR description, commit messages, or the human if both are useless |

Read the diff with `git diff <range>`.
Read whole files from `head_worktree`, and their previous state from `base_worktree`.

## What you must not do

**Do not review.**
No verdicts, no quality judgements, no "this looks wrong", no praise.
A reader must finish the guide without knowing your opinion of the change.

**Do not assert correctness in either direction.**
Not "this correctly handles nulls", not "this misses a null check".
If something looks consequential, point at it and ask a question.

**Do not recompute what the script already measured.**
File counts, hunk clusters, mechanical ratio, consumer counts and risky matches come from `classify.json`.
Quote them; do not re-derive them.

**Do not pad.**
Every line costs the reader time, and saving their time is the entire purpose of this artifact.
The first ten reviews called a 45-line guide on an 11-file change "way too wordy".
Length scales with `classify.json` `.tier`, and the caps below are maxima, not targets:

| Tier       | Max lines | Sections                                                     |
| ---------- | --------- | ------------------------------------------------------------ |
| `quick`    | 15        | Header, `Why this change exists` (1-2 sentences), `Files` list |
| `standard` | 30        | All sections, `Worth a closer look` capped at 3              |
| `large`    | 50        | All sections                                                 |

**Lead with the depth, not the detail.**
The reviewer's first question is "how carefully do I need to read this?".
The first line after the title answers it from `.tier` and `.effort`, so a low-risk change reads as low-risk before anything else does.

## Output

Write `guide.md` exactly in this shape.

### Quick tier

When `.tier` is `quick`, write only this, and nothing else:

````markdown
# Review Guide: <id>

**Quick review (<effort>)** - <N> files, <M> hunks, nothing deep or risky detected.
<If `.adjudicate` is non-empty, one line: "Unresolved: <keys> - <why, quoted>".>

## Why this change exists

<1-2 sentences, same rules as below.>

## Files

- `<path>` - <role, a few words>
<Code files only, in reading order. Tests and docs as one closing line.>
````

No `Worth a closer look`, no `Questions for the author`, no `Other artifacts`.
If something genuinely consequential stands out, it is a sign the tier is wrong: say so in one line under the header - "Tier may be too low: <fact>" - rather than writing the full guide.

### Standard and large tiers

````markdown
# Review Guide: <id>

**<Standard|Large> review (<effort>)** - <N> files, <M> hunks
**Classification:** <matched classifications, comma separated>
<one line per matched classification, quoting the `why` from classify.json>

## Why this change exists

<2-4 sentences. What the author is trying to accomplish, in their terms.
If the intent is not recoverable from the MR description or commits, say so
explicitly rather than inferring it from the code - a guessed "why" is worse
than an absent one.>

## Reading order

1. `<path>` - <what role this file plays in the change, one line>
2. `<path>` - <...>

<Order by what makes the change comprehensible, not by diff order or
alphabetically. Usually: the file that defines the new concept, then the one
that uses it, then the edges. Cap at 7 entries; everything else goes in the
next section as a single line.>

## Everything else

<One line listing the remaining changed files, grouped if they share a role,
e.g. "9 test files following the above; 43 generated doc rows".>

## Worth a closer look

- `<path>:<line>` - <neutral observation and the question it raises>

<Zero to five entries (three for `standard`). These are places where the change is consequential or
hard to verify from the diff alone, phrased as observations and questions, not
findings. If nothing qualifies, write "Nothing stood out" - do not manufacture
entries.>

## Questions for the author

- <question>

<Zero to five. Things only the author can answer: intent, scope decisions,
whether something was deliberate. Omit the section if empty.>

## Other artifacts

- `flow.md` - <one line on what it shows>
<only list artifacts that were actually generated>
````

## Phrasing

The distinction between a map and a review is phrasing, so it is worth being exact.

| Instead of                                | Write                                                        |
| ----------------------------------------- | ------------------------------------------------------------ |
| "This swallows the exception"             | "The catch block at :88 does not rethrow or log - intended?" |
| "Good use of the existing validator"      | "Reuses `FilterDtoValidator` rather than adding a new check" |
| "Missing test coverage for the null path" | "The null branch at :42 has no corresponding test in this diff" |
| "The naming here is confusing"            | "`fetchX` and `getX` both exist after this change"           |

Each right-hand phrasing states a verifiable fact and leaves the judgement to the reviewer.
