# Verdict file format

`verdict.md` has two readers with different needs, and the format exists to serve both without compromise.

**You**, pasting into GitLab: a worklist to execute, ordered to minimise navigation, with the exact text to copy and a way to see what is left.

**`verdict_to_record.py`**, deriving `record.json`: structured enough to extract severities, rule tags and dispositions without asking you to type them twice.

Everything below follows from those two, plus one hard rule: the fenced blocks contain only what gets pasted, and all metadata lives outside them.

## Four properties the format must have

**Metadata never reaches GitLab.**
The author does not care that your comment came from R-003.
So severity and rule tags live in the heading; the fenced block holds the comment exactly as it should appear to them.
This also means you can paste without reading - no editing a block to strip tags out.

**Grouped by file, not by severity.**
Pasting is per-file navigation: open a file in the diff view once, place every comment in it, move on.
Sorting by severity makes you open the same file three times.
The summary comment is where severity is communicated; the line comments are a motor task.

**Checkboxes, because pasting is interruptible.**
Twelve comments, a meeting, and you have lost your place.
`- [ ]` per comment makes the artifact a worklist rather than a document.

**Unstated things look unstated.**
`<not stated>` for a missing severity or verdict, never a guess.
A review that was never concluded should be visibly unconcluded.

## Shape

````markdown
---
id: STONE-1494
repo: cod-backend
head_sha: 8a86637
classification: [narrow_behavioural, risky_surface]
verdict: request changes
reviewed: 2026-02-11
wall_minutes: 35
artifacts_used: [guide, flow, notes]
---

# Verdict: STONE-1494 - request changes

## Summary comment

- [ ] posted

```text
Two blockers in the retry wrapper, five smaller things. Classification was
narrow behavioural plus risky surface (auth), so I read the security path
closely and spot-checked the generated doc rows.
```

## Line comments

### src/main/java/.../UpstreamCallExecutor.java

- [ ] **:88** `blocker` `R-003`

  ```text
  This swallows InterruptedException without restoring the interrupt flag.
  ```

- [ ] **:104** `nitpick` `new`

  ```text
  Extract this predicate - it is repeated three lines down.
  ```

### src/main/java/.../CsvExportService.java

- [ ] **:140** `follow-up` `R-015`

  ```text
  Rows are collected before writing. Fine at current volumes, but worth a
  ticket before the export limit goes up.
  ```

## General comments

- [ ] `follow-up` `new`

  ```text
  The two new config keys are not in the springdoc registry. Not blocking,
  but the next person will not find them.
  ```

## Not reviewed

43 generated doc rows under `docs/field-mappings/`, spot-checked 3.
Upstream's own account resolution - not visible from this repo.

## Reviewer notes

flow.md carried the review; callgraph.md was not needed for a change this flat.

## Agent points

| Point                           | Where                         | Disposition         |
| ------------------------------- | ----------------------------- | ------------------- |
| Retry loop never resets backoff | UpstreamCallExecutor.java:120 | adopted             |
| Export ignores the row limit    | CsvExportService.java:131     | rejected - intended |

## Scan disposition

| Rule  | Scan said | Reviewer       |
| ----- | --------- | -------------- |
| R-003 | fail      | adopted        |
| R-016 | fail      | false positive |
| R-015 | undet     | adopted        |
| R-004 | deferred  | checked, ok    |
| R-010 | deferred  | not reached    |
````

## Sections

### Frontmatter

Filled by the agent from `classify.json` and the `review_worktree.py` output, except `verdict`, `wall_minutes` and `artifacts_used`, which only the reviewer can supply.
It exists so `record.json` can be derived rather than re-elicited.

`verdict` is one of `approve`, `request changes`, `comment`, or `<not stated>`.

`artifacts_used` is a list of the artifacts the reviewer actually used, for example `[flow, guide, notes]`, or `[]` for none.
Valid names are `guide`, `flow`, `callgraph`, `residue`, `rollback`, `scan` and `notes`.
Ask the reviewer for it - never infer it from which files exist or which ones you showed them.
The parser rejects `<not stated>`.

### Summary comment

One fenced block, pasted into the MR overview.
Its own checkbox, because it is a separate paste action and easily forgotten once the line comments are done.

Mention the classification and what it caused you to skip.
That is the sentence that makes "not reviewed" visible to the author rather than hidden in your notes.

### Line comments

Grouped under an `###` heading per file, in diff order.
Within a file, in line order - the order you will encounter them scrolling down.

Each entry is `- [ ] **:<line>** <severity> <rule>` followed by an indented fenced block.
Severity is one of `blocker`, `nitpick`, `follow-up`.
Rule is a RuleID or `new`.

The two-space indent on the fenced block keeps it inside the list item, so the checkbox and its comment stay visually attached.

**GitLab suggestions.** When the reviewer dictates a concrete replacement, use a suggestion block instead of `text`, so the author can apply it in one click:

````markdown
- [ ] **:88** `blocker` `R-003`

  ```suggestion:-0+0
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        throw new CodException(CodErrorCode.UPSTREAM_TIMEOUT, e);
      }
  ```
````

The content is still the reviewer's - transcribed, not composed.
If they described the fix in prose rather than dictating code, keep it as `text` and let the author write it.

### General comments

Points with no single line to attach to - architecture, scope, something missing entirely.
Same entry shape without the `:line`.
These get pasted as separate MR-level comments, or folded into the summary; the reviewer decides.

### Not reviewed

The reviewer's words, verbatim.
Classification chose the depth, so this is where that choice becomes visible and auditable later if something escapes.

### Reviewer notes

Optional, private, free-text feedback on the process and the artifacts: what helped, what got in the way, what was ignored.
It is never posted, and is separate from `General comments`, which the MR author sees.
Copied into the record as `reviewer_notes` for the retro; leaving it empty is fine.

### Agent points

Present only when the reviewer asked for the optional second-opinion pass.
One row per point the agent raised, with what the reviewer decided:

| Disposition                    | Meaning                                 |
| ------------------------------ | --------------------------------------- |
| `adopted`                      | The reviewer added it as a review point |
| `rejected - intended`          | Real behaviour, but the author meant it |
| `rejected - not worth raising` | Real, but too small to raise            |
| `rejected - wrong`             | The agent misread the code              |

An adopted point also appears above as a normal entry, with a severity the reviewer gave.
The section's absence means the pass did not run; an empty table means it ran and raised nothing.

### Scan disposition

Every rule the scan reported on, and what the reviewer decided.

| Reviewer value   | Meaning                                                |
| ---------------- | ------------------------------------------------------ |
| `adopted`        | Became a review point above                            |
| `false positive` | Fired and was wrong - the retro counts these           |
| `not raised`     | Fired correctly, but not worth raising with the author |
| `agreed`         | Scan said pass, and the reviewer agrees                |
| `checked, ok`    | A `human` rule the reviewer verified and found fine    |
| `not reached`    | A `human` rule the reviewer did not get to             |
| `missed`         | Scan said pass, but the thing it checks for is there   |

### Which disposition fits what the scan said

Not every pairing is meaningful, and the parser rejects the ones that are not.
The mistake that matters is marking a **failure** as `checked, ok`: that reads as agreeing the rule's check is satisfied while the scan says it was violated, and it quietly drops the finding from `false_positives` - the retro's only evidence for retiring a noisy rule.

| Scan said  | Valid dispositions                                           |
| ---------- | ------------------------------------------------------------ |
| `fail`     | `adopted`, `false positive`, `not raised`                    |
| `undet`    | `adopted`, `false positive`, `not raised`, `checked, ok`, `not reached` |
| `pass`     | `agreed`, `missed`                                           |
| `deferred` | `adopted`, `checked, ok`, `not reached`                      |

For a failure you disagree with, the choice is between `false positive` (the rule was wrong) and `not raised` (the rule was right, you just are not raising it with the author).
They look similar in the moment and diverge completely over time: one retires the rule, the other keeps it.
Older verdicts used `agreed` for the second; the parser still accepts it on a failure, with a warning, and records it as `not raised`.

This table is the single highest-value part of the file for the retro.
`false positive` twice for the same rule retires it; `not raised` repeatedly means it is right but not valuable; `not reached` repeatedly means the rule is impractical as written.
It is also the only place where the agent's scan is graded, which is why the reviewer fills it and the agent does not.

## Scaffolding

Do not write this file from scratch.
It is scaffolded in two steps, so the scan stays hidden until the reviewer's own pass is done:

```
python3 scripts/scaffold_verdict.py --id STONE-1494 --no-scan    # prep, alongside notes.md
python3 scripts/scaffold_verdict.py --id STONE-1494 --add-scan   # review, when the scan is revealed
```

The first fills in everything the agent can know from the artifacts already on disk: frontmatter from `.state.json` and `classify.json`, and a `###` heading per changed code file in diff order.
The scan disposition section holds only a placeholder, because its rows would show what the scan said for each rule.

`--add-scan` adds a disposition row per rule the scan reported on, leaving everything else in the file as the reviewer left it.
Rules already in the table are skipped, so it is safe to rerun after a rescan.
It also sets `reviewed` to today, since a file scaffolded at prep would otherwise carry the prep date.
Rules the scan marked `n/a` become a trailing comment rather than rows, since they need no decision.

Without either flag, the script does both at once - for a review prepped before the verdict was scaffolded automatically.
`verdict_to_record.py` warns if `scan.md` exists but the disposition table is empty, the sign that `--add-scan` was never run.

Everything only the reviewer can know is left as `<not stated>` or `<fill>`, both of which the parser rejects.
The scaffold is a form, never a draft - it contains no points, no severities and no verdict, because those are the reviewer's and an agent-written placeholder is the first step toward an agent-written review.

It refuses to overwrite a verdict file that already has content unless given `--force`.

## Deriving the record

```
python3 scripts/verdict_to_record.py <artifacts>/verdict.md
```

Writes `record.json` beside it.
It runs the `--check` validation first and writes nothing if any check fails.
Fails loudly on `<not stated>` severities, verdict or `artifacts_used` rather than guessing, since a fabricated value corrupts the only data the retro has.

The mechanical fields come from the artifact directory, not from the verdict: `files`, `hunks` and `mechanical_ratio` from `classify.json`, `passes` from `.state.json`, `artifacts_generated` from which artifact files exist, and `scan.ran` from whether `scan.md` exists.

Warnings, which do not block the write:

- **Unparsed lines** - a non-blank line under `## Line comments` that is not a `###` heading, a point, its fenced block, or inside an HTML comment. Usually a scaffolded file list left behind. It is not in the record.
- **Notes not carried over** - a file in `notes.md` with a note under it but no entry in the verdict. Often deliberate, so it asks rather than fails.
- An empty `Not reviewed`, a missing summary block, or `request changes` with no points.
