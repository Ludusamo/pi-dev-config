# Review record schema

One `record.json` per review, written at the end of the `review` phase into the artifact directory:

```
~/pi-artifacts/pr-reviews/<repo>/<id>/record.json
```

There is no separate ledger file.
The ledger is the glob `<artifact_root>/*/*/record.json`, so it cannot drift out of sync with the artifacts it describes.
The artifact root is `PR_REVIEW_ARTIFACT_ROOT`, defaulting to `~/pi-artifacts/pr-reviews`.

## Shape

```json
{
  "id": "STONE-1474",
  "repo": "cod-backend",
  "date": "2026-02-11",
  "head_sha": "9f8e7d6",
  "classification": ["narrow_behavioural", "deep_cut"],
  "verdict": "request changes",
  "tier": "large",

  "files": 16,
  "hunks": 65,
  "mechanical_ratio": 0.34,

  "wall_minutes": 35,
  "passes": 1,

  "points": [
    {"rule": "R-003", "severity": "blocker", "path": "src/.../Mapper.java:88"},
    {"rule": "new",   "severity": "nitpick", "path": "src/.../Csv.java:140",
     "text": "repeated predicate"}
  ],

  "scan": {
    "ran": true,
    "fired": ["R-003"],
    "adopted": ["R-003"],
    "false_positives": ["R-016"],
    "not_raised": ["R-011"],
    "not_reached": ["R-010"],
    "missed": ["R-015"]
  },

  "artifacts_generated": ["guide", "flow", "callgraph"],
  "artifacts_used": ["guide", "flow", "notes"],

  "agent_points": [
    {"point": "retry loop never resets backoff", "where": "Executor.java:120",
     "disposition": "adopted"}
  ],

  "not_reviewed": "43 generated doc rows, spot-checked 3",
  "reviewer_notes": "flow.md did the work; callgraph unused on a change this flat.",
  "escaped_defects": []
}
```

`tier` comes from `classify.json` and is `quick`, `standard` or `large`.
Records written before tiers existed have none, and the retro reports them as `legacy`.

`classification` lists every class that matched: `quick`, `wide_mechanical`, `narrow_behavioural`, `wide_behavioural`, `deep_cut`, `risky_surface`.

When there is no `scan.md`, `scan` records that instead of a set of empty lists, which would look the same as a scan that ran and found nothing:

```json
"scan": {"ran": false, "reason": "no REVIEW_STANDARDS.md"}
```

`agent_points` is present only when the optional second-opinion pass ran.
Absent means it did not run; `[]` means it ran and raised nothing.

## Fields that drive the retro

Most of this is context.
These fields are what the retro actually computes on, and they are the ones most easily left blank:

**`scan.false_positives`** - rules that fired and were wrong.
Two of these for the same rule is the trigger to set `Active: false`.
Recording them is the only way a noisy rule ever gets removed, and a noisy rule is worse than no rule because it trains you to skim.

**`scan.not_raised`** - rules that fired correctly but were not worth raising with the author.
A rule that keeps landing here is right but not valuable: lower its severity or retire it.
Older verdicts spelled this `agreed`; the parser maps it across with a warning.

**`scan.missed`** - rules that should have fired and did not.
Means the rule's `Applies when` is too narrow, or the check is unevaluable as written.

**`points[].rule`** - every review point tagged with a RuleID or `new`.
The `text` of a point is the reviewer's wording, transcribed, not a summary of it.
A `new` point appearing twice across reviews is a candidate rule.
This is the main feedback path from practice back into the standards.

**`artifacts_used`** vs **`artifacts_generated`** - the gap is pure waste.
An artifact generated for five reviews and used in none should be dropped from that classification's profile.
Include `notes` when the reviewer wrote in `notes.md` - it is scaffolded every time, so this is how the retro learns whether it earns its place.
This is the field that makes reviews get *faster* rather than merely more thorough.
`artifacts_used` is a required frontmatter key in `verdict.md`; `verdict_to_record.py` refuses to write a record until it holds a list.

**`agent_points[].disposition`** - what the reviewer did with each point the second-opinion pass raised: `adopted`, `rejected - intended` (the author meant it), `rejected - not worth raising` (real, but too small to bother with), or `rejected - wrong` (the agent misread the code).
Mostly-rejected agent points, especially `rejected - wrong`, mean the second-opinion pass is noisy and should be tightened or used less.

**`reviewer_notes`** - the reviewer's private feedback on the process and the artifacts, never posted.
The retro reads it when proposing changes, alongside the numbers.

## Fields to be honest about

**`wall_minutes`** - actual time spent, not time elapsed.
The whole premise is that this speeds reviews up; without a number that claim is unfalsifiable.

**`not_reviewed`** - what the classification let you skip.
Free text. Writing it down turns skipped depth into a decision rather than a lapse, and makes it reviewable later when something escapes.

**`escaped_defects`** - appended *later*, when a bug is traced back to a change you approved.
Always empty at write time.
Append with `retro.py escaped --repo <repo> --id <id> --note "..."`, which adds `{"date": ..., "note": ...}`.
It is the only true measure of whether the process works, and the only field that requires going back to amend an old record.

## Who supplies what

The record is written by the agent but is not the agent's opinion.

| Source               | Fields                                                       |
| -------------------- | ------------------------------------------------------------ |
| `classify.json`      | `classification`, `tier`, `files`, `hunks`, `mechanical_ratio` |
| `review_worktree.py` | `id`, `repo`, `head_sha`, `passes` (count of `.state.json` passes) |
| Mechanical           | `date`, `artifacts_generated` (which artifact files exist), `scan.ran` |
| **The reviewer**     | `verdict`, every `points[].severity`, every `points[].text`, `scan.false_positives`, `scan.missed`, `artifacts_used`, `agent_points[].disposition`, `not_reviewed`, `reviewer_notes`, `wall_minutes` |

`verdict_to_record.py` fills every non-reviewer field itself, from the files in the artifact directory.
It omits a field, with a warning, when the source file is missing.
`retro.py backfill --write` fills the same mechanical fields into older records that lack them, and never touches a reviewer field.

Nothing in the reviewer row may be inferred.
A severity the agent chose, or a `false_positives` list it decided on its own, corrupts the retro at the exact point the retro is supposed to be measuring the agent.
Leave a field out rather than guessing it.

## Conventions

- `id` matches the artifact directory name.
- `date` is ISO `YYYY-MM-DD`, the day the review was completed.
- `passes` increments when a review resumes after the author pushes more commits.
- Unknown values are omitted rather than guessed. A missing `wall_minutes` is honest; a fabricated one corrupts the only metric that matters.
