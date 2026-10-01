---
name: pr-review
description: Structured PR/MR review. Classifies a change by blast radius and risk, generates orientation artifacts (review guide, flow diff, call graph, rollback notes), checks the repo's REVIEW_STANDARDS.md rules, then walks the human through a review and records the verdict for later analysis. Use when asked to review a PR/MR, prep a review, look at a branch or diff before approving, or run a review retro. Review-only - this skill never writes application code.
---

# PR Review

A review pipeline that does the mechanical work up front so the human can spend their attention on judgement.
Three phases, run separately:

| Phase    | When                       | Produces                                   |
| -------- | -------------------------- | ------------------------------------------ |
| `prep`   | Before reading the diff    | Artifacts on disk: guide, scan, diagrams    |
| `review` | Sitting down to review     | The verdict, in paste-ready blocks          |
| `retro`  | Periodically, across many  | Proposed amendments to REVIEW_STANDARDS.md  |

Default to `prep` when the phase is not stated and no artifacts exist yet; default to `review` when they do.

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

| Platform             | Command            |
| -------------------- | ------------------ |
| Linux / macOS / WSL  | `python3 scripts/` |
| Windows PowerShell   | `py -3 scripts/`   |

Run from inside the repository being reviewed.

Reviews are stored in two configurable roots: worktrees under `~/reviews`, artifacts and records under `~/notes/pr-reviews`.
Both can be overridden globally or per repository - see `references/configuration.md`.
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

If a prompt file does not exist yet, skip that artifact and name it in the report as not generated.
Never improvise an artifact without its prompt - an inconsistent artifact is worse than a missing one, because the reviewer cannot tell which they are holding.

### 5. Scan the standards

Run `prompts/scanner.md`.
Write the result to `<artifacts>/scan.md`.

### 6. Report back

Show the human **the guide only**, plus one line naming the other artifacts and where they are.
Do not summarize, quote, or hint at the scan results.

## Phase: review

Work through this in order.
The order is the point: it keeps the human's first impression their own.

1. **Orient.** Show `guide.md`, and any flow/call-graph/residue artifact. Nothing else.
2. **Their pass.** Let them read the change and talk. Capture their observations verbatim as they go. Answer clarifying questions about the code; do not volunteer opinions on quality.
3. **Reveal the scan.** Now show `scan.md`. For each finding ask whether it is real, and whether they want it in the verdict. A scan failure is **not** a review point until the reviewer adopts it - otherwise the scan quietly authors blockers. Record rejected findings as false positives; the retro needs them.
4. **Human-only checklist.** List every `Active: true` rule in `REVIEW_STANDARDS.md` with `Checkable by: human`. These were never scanned. Work through each one; AI silence is not evidence.
5. **Transcribe the verdict.** Scaffold the file first with `python3 scripts/scaffold_verdict.py --id <id>`, which pre-fills frontmatter, a heading per changed code file, and a disposition row per scanned rule. Then fill it in from what the reviewer said. See the transcription rules.
6. **Record.** Run `python3 scripts/verdict_to_record.py <artifacts>/verdict.md`. It derives `record.json` from the verdict rather than making the reviewer state anything twice, and refuses to run if a severity or the verdict is missing. Add any field it cannot know - `wall_minutes`, `artifacts_used` - per `references/record-schema.md`.
7. **Sync.** Run `python3 scripts/prconfig.py sync -m "<id>"`. This commits the artifact root when it is a git repo and is a harmless no-op otherwise, so call it unconditionally.

### Transcription rules

The reviewer dictates; you record.
The line between the two is narrow enough to be worth stating precisely.

| You may                                                        | You must not                                                      |
| -------------------------------------------------------------- | ------------------------------------------------------------------ |
| Format their words into the block structure                     | Rewrite, polish, soften or sharpen their wording                    |
| Resolve a `file:line` they described in prose                   | Add a point they did not raise                                      |
| Propose a RuleID tag for a point, for them to confirm           | Assign severity - that is theirs                                    |
| Point out that a scan finding was never ruled on                | Carry a scan finding into the verdict unadopted                     |
| Ask which of two readings of an ambiguous remark they meant     | Pick the reading that seems more likely                             |
| Note that no overall verdict has been stated yet                | Infer the verdict from the points                                   |
| Flag a `human` rule they have not worked through                | Record it as satisfied because nothing contradicted it              |

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

- **Frontmatter** carries `id`, `repo`, `head_sha`, `classification`, `verdict`, `reviewed`, `wall_minutes`. You fill all but `verdict` and `wall_minutes` from `classify.json` and the worktree JSON.
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

## References

- `references/standards-format.md` - the REVIEW_STANDARDS.md spec, including calibration targets
- `references/record-schema.md` - the ledger entry shape
- `references/verdict-format.md` - the verdict file specification, with a worked example
- `references/configuration.md` - storage roots, precedence, and the artifact root as a synced git repo
