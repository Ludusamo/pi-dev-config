# Review record schema

One `record.json` per review, written at the end of the `review` phase into the artifact directory:

```
~/notes/pr-reviews/<repo>/<id>/record.json
```

There is no separate ledger file.
The ledger is the glob `<artifact_root>/*/*/record.json`, so it cannot drift out of sync with the artifacts it describes.
The artifact root is `PR_REVIEW_ARTIFACT_ROOT`, defaulting to `~/notes/pr-reviews`.

## Shape

```json
{
  "id": "STONE-1474",
  "repo": "cod-backend",
  "date": "2026-02-11",
  "head_sha": "9f8e7d6",
  "classification": ["narrow_behavioural", "deep_cut"],
  "verdict": "request changes",

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
    "fired": ["R-003"],
    "false_positives": ["R-016"],
    "undetermined": ["R-004"],
    "missed": ["R-015"]
  },

  "artifacts_generated": ["guide", "flow", "callgraph"],
  "artifacts_used": ["guide", "flow"],

  "not_reviewed": "43 generated doc rows, spot-checked 3",
  "escaped_defects": []
}
```

## Fields that drive the retro

Most of this is context.
Four fields are what the retro actually computes on, and they are the ones most easily left blank:

**`scan.false_positives`** - rules that fired and were wrong.
Two of these for the same rule is the trigger to set `Active: false`.
Recording them is the only way a noisy rule ever gets removed, and a noisy rule is worse than no rule because it trains you to skim.

**`scan.missed`** - rules that should have fired and did not.
Means the rule's `Applies when` is too narrow, or the check is unevaluable as written.

**`points[].rule`** - every review point tagged with a RuleID or `new`.
The `text` of a point is the reviewer's wording, transcribed, not a summary of it.
A `new` point appearing twice across reviews is a candidate rule.
This is the main feedback path from practice back into the standards.

**`artifacts_used`** vs **`artifacts_generated`** - the gap is pure waste.
An artifact generated for five reviews and used in none should be dropped from that classification's profile.
This is the field that makes reviews get *faster* rather than merely more thorough.

## Fields to be honest about

**`wall_minutes`** - actual time spent, not time elapsed.
The whole premise is that this speeds reviews up; without a number that claim is unfalsifiable.

**`not_reviewed`** - what the classification let you skip.
Free text. Writing it down turns skipped depth into a decision rather than a lapse, and makes it reviewable later when something escapes.

**`escaped_defects`** - appended *later*, when a bug is traced back to a change you approved.
Always empty at write time.
It is the only true measure of whether the process works, and the only field that requires going back to amend an old record.

## Who supplies what

The record is written by the agent but is not the agent's opinion.

| Source               | Fields                                                       |
| -------------------- | ------------------------------------------------------------ |
| `classify.json`      | `classification`, `files`, `hunks`, `mechanical_ratio`       |
| `review_worktree.py` | `id`, `repo`, `head_sha`, `passes`                           |
| Mechanical           | `date`, `artifacts_generated`                                |
| **The reviewer**     | `verdict`, every `points[].severity`, every `points[].text`, `scan.false_positives`, `scan.missed`, `artifacts_used`, `not_reviewed`, `wall_minutes` |

Nothing in the reviewer row may be inferred.
A severity the agent chose, or a `false_positives` list it decided on its own, corrupts the retro at the exact point the retro is supposed to be measuring the agent.
Leave a field out rather than guessing it.

## Conventions

- `id` matches the artifact directory name.
- `date` is ISO `YYYY-MM-DD`, the day the review was completed.
- `passes` increments when a review resumes after the author pushes more commits.
- Unknown values are omitted rather than guessed. A missing `wall_minutes` is honest; a fabricated one corrupts the only metric that matters.
