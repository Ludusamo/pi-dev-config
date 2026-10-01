# Prompt: Scanner

Produces `scan.md`: a verdict per rule in the repo's `REVIEW_STANDARDS.md`.

This is the one step that is allowed to say something failed.
In exchange it is tightly bounded: it checks the rules and nothing else.

"Verdict" below means the outcome of a single rule, not the review's verdict.
A `fail` here is a candidate review point, not a blocker.
It becomes one only if the human adopts it during the review phase - severity and the overall call are theirs alone.

## Inputs

| Input                 | Where it comes from                      |
| --------------------- | ---------------------------------------- |
| `REVIEW_STANDARDS.md` | repository root                          |
| `repo_path`, `range`  | `review_worktree.py` JSON                |
| `head_worktree`       | `.worktrees.head`, for reading whole files |
| `classify.json`       | written by `classify.py`                 |

## Scope

Evaluate **only** rules with `Active: true` **and** `Checkable by: ai`.

Never issue a verdict on a `Checkable by: human` rule.
A speculative pass on one is worse than no answer, because it invites the reviewer to skip a check only they can do.

But do not leave them bare either.
For each, supply a **pointer without a verdict**: where in the diff the relevant evidence would be, or where the author appears to have addressed it, so the human starts their check somewhere instead of from nothing.
This is the single biggest time saving available on human rules, and it costs nothing in independence as long as the pointer stays a location rather than a conclusion.

| Write                                                                 | Not                                      |
| --------------------------------------------------------------------- | ---------------------------------------- |
| "`FooTest.java:797` claims the keys were transcribed from a live payload on 2026-09-29, naming two source trades." | "R-004 passes, the author transcribed it." |
| "No allowlist file changed; `Foo.java:20` states this surface has no filter/sort. Likely n/a - confirm." | "R-010 is not applicable."                 |

If you can find no relevant location at all, say so plainly - that absence is itself useful to the reviewer.

Do not report anything that is not a rule.
Code smells, style opinions and improvement ideas are out of scope here - the guide covers orientation and the human covers judgement.
If you notice something genuinely alarming that no rule covers, add it under "Unruled observation" at the end, limited to one line, and flag it as a candidate new rule.

## Method

For each in-scope rule:

1. Evaluate `Applies when` against the changed paths and diff content. Not triggered means `n/a` - stop there, do not look further.
2. Evaluate `Check` against the diff, and against whole files from `head_worktree` where the diff alone is insufficient.
3. Produce the evidence named in the rule's `Evidence` field.

### Verdicts

| Verdict | Meaning                                                                 |
| ------- | ----------------------------------------------------------------------- |
| `pass`  | The check holds, and you can cite where.                                 |
| `fail`  | The check is violated, and you can cite where.                           |
| `undet` | Triggered, but you cannot establish either answer from available evidence. |
| `n/a`   | `Applies when` did not trigger.                                          |

**`undet` is a first-class answer, not a failure of effort.**
Use it whenever the evidence is outside the diff and the worktree - author intent, a live upstream payload, a decision made in a meeting.
Never guess to avoid it.

**Evidence is mandatory for `pass` and `fail`.**
A `pass` with no citation is indistinguishable from not having checked, which is how a scan quietly becomes worthless.
If you cannot cite, the verdict is `undet`.

Two sentences maximum per rule.
These are read in a batch; length is friction.

## Adjudication

`classify.json` has an `.adjudicate` list - classifications the script would not decide, plus `.signals.risky_topics_unmatched`, which are prose risky surfaces like "Concurrency" that cannot be path-matched.

Answer each one directly, with evidence, in the Adjudication section.
Keep each to one or two sentences.
If answering `deep_cut` or `risky_surface` as yes changes which artifacts should exist, say so - the reviewer may want to generate the missing one.

## Output

Write `scan.md` exactly in this shape.

````markdown
# Standards Scan: <id>

<N> rules evaluated, <F> failed, <U> undetermined, <H> deferred to human.

## Failures

| Rule  | Severity | Evidence |
| ----- | -------- | -------- |
| R-003 | blocker  | `path/File.java:88` - <one or two sentences> |

## Undetermined

| Rule  | Why |
| ----- | --- |
| R-004 | <what evidence is missing and who can supply it> |

## Passed

<Rule IDs on one line, comma separated, with the citation for each in parentheses.
Keep this compact - it exists to prove the check ran, not to be read closely.>

## Deferred to human

<One bullet per rule: the ID, its one-line `Check`, and a starting point -
the location where the evidence lives or appears to live, phrased as a
location and never as a verdict. These rules were NOT evaluated.>

## Not applicable

<Rule IDs only, one line.>

## Adjudication

- **<question from .adjudicate>**: <answer, with evidence>

## Unruled observation

<At most one line, only if genuinely warranted. Omit the section otherwise.>
````

Order matters: failures first, because that is what gets acted on.
Passed and n/a are compressed deliberately - they are receipts, not reading material.
