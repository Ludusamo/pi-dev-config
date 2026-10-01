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
| `retro`  | Periodically, across many | Proposed amendments to REVIEW_STANDARDS.md               |

Default to `prep` when the phase is not stated and no artifacts exist yet; default to `review` when they do.

Where files live (both roots are configurable - see `references/configuration.md`):

| What      | Default root         | Lifetime                                        |
| --------- | -------------------- | ----------------------------------------------- |
| Worktrees | `~/reviews`          | Deleted at the end of the review                |
| Artifacts | `~/notes/pr-reviews` | Kept - notes, verdict and record, for the retro |

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

Read `.classification` for what the change is, `.artifacts` for what to generate, and `.adjudicate` for the questions the script refused to guess at.

If `.signals.standards_found` is false, say so plainly, skip the scan step, and offer to draft a starter `REVIEW_STANDARDS.md` from `references/standards-format.md`.

### 3. Build the guide - before anything else

Run `prompts/cartographer.md` with the inputs it names.
Write the result to `<artifacts>/guide.md`.

Do not read `REVIEW_STANDARDS.md` before this step completes.

### 4. Build the remaining artifacts

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

### 6. Scaffold the reviewer's notes

```
python3 scripts/scaffold_notes.py --id <id>
```

Writes `<artifacts>/notes.md`: a heading per changed file (all files, not only code) in diff order with its `+/-` counts and a `- [ ] read` checkbox, plus empty `First impressions`, `Cross-cutting`, `Questions` and `Not reviewed` sections.
It contains structure only, so it is safe to create after the scan - nothing from `scan.md` goes in it.
It refuses to overwrite a non-empty file; use `--update` to add files, `--force` only if the reviewer asks to start over.

### 7. Report back

Show the human **the guide only**, plus one line naming the other artifacts and where they are.
Point them at `notes.md` as the place to jot thoughts while they read - in their editor, alongside the diff.
Do not summarize, quote, or hint at the scan results.

## Phase: review

Work through this in order.
The order is the point: it keeps the human's first impression their own.

1. **Orient.** Show `guide.md`, and any flow/call-graph/residue artifact. Nothing else.
2. **Their pass.** Let them read the change and talk, writing in `notes.md` as they go. Capture anything they say aloud verbatim into `notes.md` under the relevant file heading (or `Cross-cutting`), so the file stays the single record of their pass. Re-read `notes.md` before each reply - they may have edited it in their editor since. Answer clarifying questions about the code; do not volunteer opinions on quality. Unticked `read` boxes at the end are files they have not been through; mention them, do not judge them.
3. **Reveal the scan.** Now show `scan.md`. For each finding ask whether it is real, and whether they want it in the verdict. A scan failure is **not** a review point until the reviewer adopts it - otherwise the scan quietly authors blockers. Record rejected findings as false positives; the retro needs them.
4. **Human-only checklist.** List every `Active: true` rule in `REVIEW_STANDARDS.md` with `Checkable by: human`. These were never scanned. Work through each one; AI silence is not evidence.
5. **Transcribe the verdict.** Scaffold the file first with `python3 scripts/scaffold_verdict.py --id <id>`, which pre-fills frontmatter, a heading per changed code file, and a disposition row per scanned rule. Then fill it in from what the reviewer said and wrote in `notes.md`. Walk the notes with them file by file: for each note, ask whether it becomes a point, and at what severity. Shorthand like `!` or `~` is a hint for that question, never an answer to it. Their `Not reviewed` notes seed the verdict's `Not reviewed` section, verbatim. See the transcription rules.
6. **Second opinion - only if the reviewer asks.** See [Second-opinion pass](#second-opinion-pass). Never offer it as a default step and never run it unasked.
7. **Finish.** Once the reviewer says the verdict is posted, work through the [finish checklist](#finish-checklist) without waiting to be asked for each step.

### Second-opinion pass

Optional, and only on the reviewer's request, after the verdict is transcribed.
It comes last so it cannot shape their first impression or their verdict.

Read `notes.md` and `verdict.md`, then raise any points you disagree with or think deserve another look.

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

Record every point raised in a `## Agent points` table in `verdict.md` - `Point | Where | Disposition` - with the reviewer's call on each: `adopted`, `rejected - intended`, or `rejected - wrong`.
See `references/verdict-format.md`.
The retro uses it to judge whether this pass earns its place.

### Finish checklist

Run in order, after the verdict is posted.
Stop at the first step that fails and say why.

1. **Ask for the reviewer-only fields.** `artifacts_used` in the frontmatter - which artifacts they actually used, e.g. `[flow, guide, notes]`. Ask; never guess it from what exists or what you showed them. Also ask whether they have anything for the optional, private `## Reviewer notes` section: feedback on the process and the artifacts, for the retro.
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
- **Scan disposition table** records what you decided about each scan finding - `adopted`, `false positive`, `agreed`, `checked, ok`, `not reached`, `missed`. This is the only place the scan gets graded, and the retro's main input.

Tag every point with the RuleID it came from, or `new` if no rule covers it.
You may propose the tag by matching the point against the rules; the reviewer confirms it.

Record **what was not reviewed and why**, in the reviewer's words - the honest counterpart to letting classification pick the depth.

Write `<not stated>` for any severity or verdict the reviewer has not given.
The parser rejects those rather than defaulting them, which is the intended behaviour: an unconcluded review should fail to produce a record.

## Phase: retro

Not yet implemented.
It will read accumulated `record.json` files and propose amendments to `REVIEW_STANDARDS.md`: new rules from recurring `new` points, `Active: false` for rules that keep producing false positives, and artifact types nobody reads.

It should also:

- Read `reviewer_notes` when proposing changes to the process or the artifacts.
- Flag it when `agent_points` are mostly rejected, as a sign the second-opinion pass is noisy.
- Skip records with `scan.ran: false` when computing scan statistics.

## References

- `references/standards-format.md` - the REVIEW_STANDARDS.md spec, including calibration targets
- `references/record-schema.md` - the ledger entry shape
- `references/verdict-format.md` - the verdict file specification, with a worked example
- `references/configuration.md` - storage roots, precedence, and the artifact root as a synced git repo
