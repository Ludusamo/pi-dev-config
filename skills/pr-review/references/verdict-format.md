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

Filled by the agent from `classify.json` and the `review_worktree.py` output, except `verdict` and `wall_minutes`, which only the reviewer can supply.
It exists so `record.json` can be derived rather than re-elicited.

`verdict` is one of `approve`, `request changes`, `comment`, or `<not stated>`.

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

### Scan disposition

Every rule the scan reported on, and what the reviewer decided.

| Reviewer value   | Meaning                                                |
| ---------------- | ------------------------------------------------------ |
| `adopted`        | Became a review point above                             |
| `false positive` | Fired and was wrong - the retro counts these            |
| `agreed`         | Correct, but not worth raising with the author          |
| `checked, ok`    | A `human` rule the reviewer verified and found fine     |
| `not reached`    | A `human` rule the reviewer did not get to              |
| `missed`         | Scan said pass, but the thing it checks for is there    |

This table is the single highest-value part of the file for the retro.
`false positive` twice for the same rule retires it; `not reached` repeatedly means the rule is impractical as written.
It is also the only place where the agent's scan is graded, which is why the reviewer fills it and the agent does not.

## Scaffolding

Do not write this file from scratch.

```
python3 scripts/scaffold_verdict.py --id STONE-1494
```

Fills in everything the agent can know from the artifacts already on disk: frontmatter from `.state.json` and `classify.json`, a `###` heading per changed code file in diff order, and a disposition row per rule the scan reported on.
Rules the scan marked `n/a` become a trailing comment rather than rows, since they need no decision.

Everything only the reviewer can know is left as `<not stated>` or `<fill>`, both of which the parser rejects.
The scaffold is a form, never a draft - it contains no points, no severities and no verdict, because those are the reviewer's and an agent-written placeholder is the first step toward an agent-written review.

It refuses to overwrite a verdict file that already has content unless given `--force`.

## Deriving the record

```
python3 scripts/verdict_to_record.py <artifacts>/verdict.md
```

Writes `record.json` beside it.
Fails loudly on `<not stated>` severities or verdict rather than guessing, since a fabricated severity corrupts the only data the retro has.
