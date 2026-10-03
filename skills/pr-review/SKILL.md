---
name: pr-review
description: Structured PR/MR review. Classifies a change by blast radius and risk, generates orientation artifacts (review guide, flow diff, call graph, rollback notes), checks the repo's REVIEW_STANDARDS.md rules, then walks the human through a review and records the verdict for later analysis. Use when asked to review a PR/MR, prep a review, look at a branch or diff before approving, or run a review retro. Review-only - this skill never writes application code.
---

# PR Review

A review pipeline that does the mechanical work up front so the human can spend their attention on judgement.
Three phases, run separately:

| Phase    | When                      | Produces                                                 |
| -------- | ------------------------- | -------------------------------------------------------- |
| `prep`   | Before reading the diff   | Artifacts on disk: guide, scan, diagrams, notes scaffold |
| `review` | Sitting down to review    | The verdict, in paste-ready blocks                       |
| `retro`  | Periodically, across many | Proposed changes to REVIEW_STANDARDS.md and the process  |

Default to `prep` when the phase is not stated and no artifacts exist yet; default to `review` when they do.

Where files live (both roots are configurable - see `references/configuration.md`):

| What      | Default root         | Lifetime                                        |
| --------- | -------------------- | ----------------------------------------------- |
| Worktrees | `~/reviews`          | Deleted at the end of the review                |
| Artifacts | `~/pi-artifacts/pr-reviews` | Kept - notes, verdict and record, for the retro |

## Hard rules

**Never write, edit, or fix application code.**
This skill reviews.
Fixes happen in a separate session, which also keeps the recorded verdict honest.

**Never show scan findings during `prep`.**
The scan runs and is written to disk, but surfacing it before the human's own pass means they review the scan instead of the change.
`review` reveals it at the right moment.

**The verdict is the human's. You transcribe it, you never author it.**
Every review point, its severity, and the overall verdict come from the reviewer.
You format what they said into paste-ready blocks and nothing more.
A verdict you wrote is a review you performed, which is the one thing this process exists to prevent.

**`notes.md` is the reviewer's scratchpad, not yours.**
You may append what they say aloud, verbatim, under the file it concerns.
You never add your own observations, scan findings, or tidy up their wording there.
A note is raw material, not a review point - it becomes one only when they confirm it and give it a severity at transcription.

**Tables are column-aligned.**
These artifacts are read in a plain text editor far more often than they are rendered, and a ragged table is hard work there.
After writing any artifact, run `python3 scripts/mdtable.py <file>` to align it.
Keep cells short enough to stay readable - put detail in prose under the table, not in a 400-character cell.

**Diagrams are ASCII, never mermaid.**
Plain ASCII in a fenced block, assuming a monospace font, under 90 columns.
Artifacts get read in terminals, diff views and GitLab comment boxes, and a mermaid block that does not render is worse than no diagram at all.
No box-drawing characters either - ASCII only.

**Generate the guide before loading REVIEW_STANDARDS.md.**
Ordering is what keeps the map free of verdicts.
Once rules are in context, every description of the change is coloured by them.

## Invocation

Scripts are plain `python3` + `git`, no dependencies.
Paths below are relative to this skill directory.

| Platform            | Command            |
| ------------------- | ------------------ |
| Linux / macOS / WSL | `python3 scripts/` |
| Windows PowerShell  | `py -3 scripts/`   |

Run from inside the repository being reviewed.

The two storage roots in the table above can be overridden globally or per repository - see `references/configuration.md`.
Run `python3 scripts/prconfig.py show` to print the resolved paths and where each came from; do that first if artifacts turn up somewhere unexpected.

Never hardcode either root.
Take `.artifacts` and `.worktrees` from the `review_worktree.py` output, which already reflects the resolved configuration.

## Phase: prep

### 1. Materialize the worktrees

```
python3 scripts/review_worktree.py add --base <base-ref> --head <head-ref> --id <TICKET>
```

Defaults are `origin/HEAD` and `HEAD`.
`--id` should be the ticket or MR number; it names the artifact directory.
Add `--sparse` on a large repo to check out only the directories the diff touches.

Keep the JSON it prints.
Every later step takes `.repo_path`, `.range`, `.worktrees.base`, `.worktrees.head` and `.artifacts` from it.
Read those paths from the JSON rather than constructing them - the convenience symlinks do not exist on Windows.

If the output contains `since_last_pass`, the branch moved since the previous pass.
Say so, and offer an incremental review of just that range.
If `notes.md` already exists, run `python3 scripts/scaffold_notes.py --id <id> --update --range <since_last_pass>` instead of re-scaffolding it: it adds headings for newly touched files and puts a re-read checkbox under any already-noted file that changed again, without touching what the reviewer wrote.

### 2. Classify

```
python3 scripts/classify.py --repo-path <repo_path> --range <range> \
        --head-worktree <worktrees.head> > <artifacts>/classify.json
```

This is the deterministic half: file and hunk counts, mechanical-substitution clustering, changed test expectations, shared-contract consumers, risky-surface matches.
Do not recompute any of it by reading the diff yourself.

Read `.classification` for what the change is, `.tier` and `.effort` for how deep the review should go, `.artifacts` for what to generate, and `.adjudicate` for the questions the script refused to guess at.

`.tier` is `quick`, `standard` or `large`.
`quick` means small (at most 15 code files and 80 code hunks), with no deep cut and no risky-surface match.
For a `quick` change the whole prep is a short guide, plus the scan if the repo has standards, so the reviewer can just go and read the files.
Do not generate anything else for it, even if a step below would otherwise ask for it.
If you think the tier is wrong, say so in one line and let the reviewer choose; never upgrade it silently.

If `.signals.standards_found` is false, say so plainly, skip the scan step, and offer to draft a starter `REVIEW_STANDARDS.md` from `references/standards-format.md`.

### 3. Build the guide - before anything else

Run `prompts/cartographer.md` with the inputs it names.
Write the result to `<artifacts>/guide.md`.

Do not read `REVIEW_STANDARDS.md` before this step completes.

### 4. Build the remaining artifacts

Skip this step for the `quick` tier - `.artifacts` holds only `guide`.

For each entry in `.artifacts` from classify.json other than `guide`, run the matching prompt and write its output next to the guide:

| Entry       | Prompt                  | Output         |
| ----------- | ----------------------- | -------------- |
| `residue`   | `prompts/residue.md`    | `residue.md`   |
| `flow`      | `prompts/flow-diff.md`  | `flow.md`      |
| `callgraph` | `prompts/call-graph.md` | `callgraph.md` |
| `rollback`  | `prompts/rollback.md`   | `rollback.md`  |

These are independent.
Run them in parallel if the host supports it, sequentially otherwise.

After writing each artifact, align its tables:

```
python3 scripts/mdtable.py <artifacts>/*.md
```

If a prompt file does not exist yet, skip that artifact and name it in the report as not generated.
Never improvise an artifact without its prompt - an inconsistent artifact is worse than a missing one, because the reviewer cannot tell which they are holding.

### 5. Scan the standards

Run `prompts/scanner.md`.
Write the result to `<artifacts>/scan.md`.

### 6. Scaffold the reviewer's notes and the verdict

```
python3 scripts/scaffold_notes.py --id <id>          # skip for the quick tier
python3 scripts/scaffold_verdict.py --id <id> --no-scan
```

`notes.md` is deliberately minimal: a title, one comment line, and empty `Notes`, `Questions` and `Not reviewed` sections.
No frontmatter, no checkboxes, no per-file list.
The reviewer writes a file name or `path:line` and a note, in any shape.
Add `--files` only if the reviewer asks for a heading per changed file.
For the `quick` tier, do not scaffold it at all unless the reviewer asks for it.
It contains structure only, so it is safe to create after the scan - nothing from `scan.md` goes in it.
It refuses to overwrite a non-empty file; use `--update --range <since_last_pass>` on a later pass, `--force` only if the reviewer asks to start over.

`verdict.md` is scaffolded now too, so the reviewer has the form from the start and can draft comments into it as they go.
It holds frontmatter, a heading per changed code file, and empty sections - no points, severities or verdict.
`--no-scan` is mandatory here: the scan disposition rows show what the scan said for each rule, so they stay out until the scan is revealed.
If `verdict.md` already exists (a later pass), leave it alone.

### 7. Report back

Show the human **the guide only**, plus one line naming the other artifacts and where they are.
For the `quick` tier, that is the whole report: the guide, and "read the files".
Otherwise, point them at `notes.md` as the place to jot thoughts while they read - in their editor, alongside the diff - and mention that `verdict.md` is scaffolded and ready for when they conclude.
Do not summarize, quote, or hint at the scan results.

## Phase: review

Work through this in order.
The order is the point: it keeps the human's first impression their own.

1. **Orient.** Show `guide.md`, and any flow/call-graph/residue artifact. Nothing else.
2. **Their pass.** Let them read the change and talk, writing in `notes.md` as they go. Capture anything they say aloud verbatim into `notes.md` under `Notes`, prefixed with the file or `path:line` it concerns, so the file stays the single record of their pass. Re-read `notes.md` before each reply - they may have edited it in their editor since. Answer clarifying questions about the code; do not volunteer opinions on quality. On the `quick` tier, if there is no `notes.md`, take notes in the conversation and write them into `verdict.md` at transcription instead.
3. **Reveal the scan.** Run `python3 scripts/scaffold_verdict.py --id <id> --add-scan` to fill the scan disposition rows into `verdict.md` - it touches nothing else in the file and is safe to rerun. Then show `scan.md`. For each finding ask whether it is real, and whether they want it in the verdict. A scan failure is **not** a review point until the reviewer adopts it - otherwise the scan quietly authors blockers. Record rejected findings as false positives; the retro needs them.
4. **Human-only checklist.** List every `Active: true` rule in `REVIEW_STANDARDS.md` with `Checkable by: human`. These were never scanned. Work through each one; AI silence is not evidence.
5. **Transcribe the verdict.** `verdict.md` was scaffolded during prep, and step 3 added the disposition rows. If it is missing (a review prepped before this was automatic), scaffold it now with `python3 scripts/scaffold_verdict.py --id <id>`. Re-read it first - the reviewer may have drafted into it already. Then fill it in from what the reviewer said and wrote in `notes.md`. Walk the notes with them file by file: for each note, ask whether it becomes a point, and at what severity. Shorthand like `!` or `~` is a hint for that question, never an answer to it. Their `Not reviewed` notes seed the verdict's `Not reviewed` section, verbatim. See the transcription rules.
6. **Second opinion - only if the reviewer asks.** See [Second-opinion pass](#second-opinion-pass). Never offer it as a default step and never run it unasked.
7. **Finish.** Once the reviewer says the verdict is posted, work through the [finish checklist](#finish-checklist) without waiting to be asked for each step.

### Second-opinion pass

Optional, and only on the reviewer's request, after the verdict is transcribed.
It comes last so it cannot shape their first impression or their verdict.

Read `notes.md` and `verdict.md`, then raise any points you disagree with or think deserve another look.

**Raise only what you would call a blocker or a follow-up.**
Across the first ten reviews, 9 of 10 agent points were rejected.
Most were real but not worth raising: "not realistic", "fine for now", "already requested elsewhere", a missing test for a defensive branch.
Do not raise nitpicks, untested trivial branches, things the author clearly chose, or things you know are tracked elsewhere.
Zero points is a normal outcome, not a failure.

- **Confirm before raising.** Check every concern against the code first: trace the logic, read the tests. A concern you could not confirm is either mentioned as checked-and-dropped or not mentioned at all. An unverified hunch costs the reviewer the time you skipped.
- **Look hardest where they did not.** Spend most of the pass on the areas listed under `Not reviewed`.
- **The verdict does not change.** You raise; the reviewer decides what, if anything, gets added, and at what severity. The transcription rules still apply.
- **Draft paste-ready.** Any comment you propose is drafted ready to drop into `verdict.md`: the `### <file>` heading if that file has none yet, then the entry line and the comment in an indented `text` block. Severity and rule are your suggestion, for the reviewer to confirm or change:

  ````markdown
  ### src/main/java/.../UpstreamCallExecutor.java

  - [ ] **:120** `follow-up` `new`

    ```text
    The backoff is never reset after a successful call, so ...
    ```
  ````

Record every point raised in a `## Agent points` table in `verdict.md` - `Point | Where | Disposition` - with the reviewer's call on each: `adopted`, `rejected - intended`, `rejected - not worth raising`, or `rejected - wrong`.
Ask which one; "real but not worth it" is `not worth raising`, not `intended`.
See `references/verdict-format.md`.
The retro uses it to judge whether this pass earns its place.

### Finish checklist

Run in order, after the verdict is posted.
Stop at the first step that fails and say why.

1. **Ask for the reviewer-only fields.** `artifacts_used` in the frontmatter - which artifacts they actually used, e.g. `[flow, guide, notes]`. Ask; never guess it from what exists or what you showed them. If `## Not reviewed` is empty, ask what they skipped or skimmed - "nothing, I read everything" is a valid answer and worth recording; 7 of the first 10 records left it blank, and by the retro nobody remembered. Also ask whether they have anything for the optional, private `## Reviewer notes` section: feedback on the process and the artifacts, for the retro.
2. **Record.** `python3 scripts/verdict_to_record.py <artifacts>/verdict.md`. It validates first, exactly as `--check` does, and writes nothing if any check fails - fix those with the reviewer, then rerun. It fills the mechanical fields itself (`files`, `hunks`, `mechanical_ratio`, `passes`, `artifacts_generated`, `scan.ran`). Relay any warnings - unparsed lines under `Line comments`, notes with no verdict entry - and ask whether they are intended.
3. **Sync.** `python3 scripts/prconfig.py sync -m "<id>"`. Commits the artifact root when it is a git repo and is a harmless no-op otherwise, so call it unconditionally. If it warns that the root is not a git repo, pass the warning on.
4. **Clean up.** Only once step 2 wrote `record.json`: `python3 scripts/review_worktree.py clean --id <id>`. Works from any directory. Run it without asking, and pass on its one-line summary of what was removed and what was kept.

### Transcription rules

The reviewer dictates; you record.
The line between the two is narrow enough to be worth stating precisely.

| You may                                                     | You must not                                           |
| ----------------------------------------------------------- | ------------------------------------------------------ |
| Format their words into the block structure                 | Rewrite, polish, soften or sharpen their wording       |
| Offer each note in `notes.md` as a candidate point          | Promote a note to a point without their say-so         |
| Resolve a `file:line` they described in prose               | Add a point they did not raise                         |
| Propose a RuleID tag for a point, for them to confirm       | Assign severity - that is theirs                       |
| Point out that a scan finding was never ruled on            | Carry a scan finding into the verdict unadopted        |
| Ask which of two readings of an ambiguous remark they meant | Pick the reading that seems more likely                |
| Note that no overall verdict has been stated yet            | Infer the verdict from the points                      |
| Flag a `human` rule they have not worked through            | Record it as satisfied because nothing contradicted it |

Keep their phrasing verbatim.
A reviewer recognises their own words when the comment lands in GitLab, and a reworded point is one they have to re-verify before posting.

If something is unclear, ask.
An unanswered question is a better artifact than a confident guess - leave `<unresolved: ...>` in the file rather than filling the gap.

Two fields the reviewer must supply explicitly, and which you may never derive:

- **Severity** per point - `blocker`, `nitpick` or `follow-up`.
- **The overall verdict** - approve, request changes, or comment.

If either is missing when the file is written, leave it as `<not stated>` and say so.
A review that was never concluded should look unconcluded.

### Verdict shape

Full specification and a worked example: `references/verdict-format.md`.
Follow it exactly - `verdict_to_record.py` parses this file, so freelancing the structure costs the record.

The essentials:

- **Frontmatter** carries `id`, `repo`, `head_sha`, `classification`, `verdict`, `reviewed`, `wall_minutes`, `artifacts_used`. You fill all but `verdict`, `wall_minutes` and `artifacts_used` from `classify.json` and the worktree JSON; those three are the reviewer's.
- **`## Reviewer notes`** is optional private feedback on the process, never posted. Do not confuse it with `## General comments`, which the author sees.
- **Metadata stays outside the fenced blocks.** Severity and rule tags go in the heading; the block holds only what gets pasted. The author does not care that a comment came from R-003.
- **Line comments group by file**, in diff order, then by line. Pasting is per-file navigation - grouping by severity makes you open the same file three times.
- **Every point is a checkbox.** Pasting twelve comments is interruptible; the file is a worklist, not a document.
- **Scan disposition table** records what you decided about each scan finding - `adopted`, `false positive`, `not raised`, `agreed`, `checked, ok`, `not reached`, `missed`. This is the only place the scan gets graded, and the retro's main input.

Tag every point with the RuleID it came from, or `new` if no rule covers it.
You may propose the tag by matching the point against the rules; the reviewer confirms it.

Record **what was not reviewed and why**, in the reviewer's words - the honest counterpart to letting classification pick the depth.

Write `<not stated>` for any severity or verdict the reviewer has not given.
The parser rejects those rather than defaulting them, which is the intended behaviour: an unconcluded review should fail to produce a record.

## Phase: retro

Run periodically, across many reviews, to make the process faster and the standards sharper.
Like the review itself, the retro proposes and a human decides: never edit `REVIEW_STANDARDS.md`, the prompts or the scripts without the reviewer agreeing to each change.

### 1. Fill the mechanical gaps

```
python3 scripts/retro.py backfill            # dry run
python3 scripts/retro.py backfill --write
```

Fills only script-derived fields (`files`, `hunks`, `mechanical_ratio`, `passes`, `artifacts_generated`, `scan.ran`, `tier`) from each artifact directory.
Reviewer fields stay missing until the reviewer supplies them - never backfill `artifacts_used`, `not_reviewed` or `wall_minutes`.

### 2. Run the report

```
python3 scripts/retro.py [--repo <name>] [--since YYYY-MM-DD] [--json]
```

It prints the aggregates: reviews and time by tier, classification hit rates, artifact use against generation, scan results per rule (only records with `scan.ran: true`), second-opinion dispositions, every `new` point, reviewer notes verbatim, and data-quality gaps.
It also prints `Flags`: rules with two false positives, rules that fire and are never adopted, rules never fired, classes that match nearly everything, artifacts nobody uses, and a noisy second-opinion pass.
Show the report to the reviewer as is.

### 3. Read what the numbers cannot

- **Reviewer notes.** Group them by theme. A complaint repeated across reviews counts as much as any flag.
- **`new` points.** Judge recurrence by meaning, not wording. Two that say the same thing make a candidate rule; draft it in the `references/standards-format.md` shape.
- **Classification against the notes.** Where the reviewer asked "why is this a deep cut?", rerun `classify.py` on that range (`.repo_path` and `.range` from its `classify.json`) and find the signal that fired.
- **Time against tier.** A `quick` review that took as long as a `standard` one means the tier bounds are wrong.

### 4. Propose, then land with approval

Present the proposals as a short list, highest impact first, each with its evidence: the record IDs and the numbers or quotes behind it.
Typical targets:

| Finding                             | Proposal                                          |
| ----------------------------------- | ------------------------------------------------- |
| Rule with 2+ false positives        | `Active: false` in `REVIEW_STANDARDS.md`          |
| Rule fired often, only `not raised` | Lower its severity, or retire it                  |
| Rule `missed`                       | Widen `Applies when`, or make the check evaluable |
| Recurring `new` point               | A new rule                                        |
| Artifact generated, rarely used     | Drop it from that class in `classify.py` `wants`  |
| Class matching nearly every review  | Tighten its signal or threshold in `classify.py`  |
| Agent points mostly rejected        | Tighten the second-opinion guidance in this file  |
| Reviewer-note theme                 | Change the prompt or scaffold it is about         |

`REVIEW_STANDARDS.md` lives in the reviewed repo and is read by the team, so edit it there and leave committing to the reviewer.
After changes to `classify.py`, rerun it on the past ranges that still resolve, and show how each review would now be classified.

### Escaped defects

When a bug is traced back to a reviewed change, record it - it is the only real measure of whether the process works:

```
python3 scripts/retro.py escaped --repo <repo> --id <id> --note "<what escaped, and where it was fixed>"
```

## References

- `references/standards-format.md` - the REVIEW_STANDARDS.md spec, including calibration targets
- `references/record-schema.md` - the ledger entry shape
- `references/verdict-format.md` - the verdict file specification, with a worked example
- `references/configuration.md` - storage roots, precedence, and the artifact root as a synced git repo
