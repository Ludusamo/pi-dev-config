# Prompt: Residue

Produces `residue.md`, generated only for `wide_mechanical` changes.

A wide cut is 50 files of the same edit repeated, plus a handful of hunks that are something else.
Those few hunks are the entire review.
This artifact separates them so the reviewer does not have to find them by scrolling.

## Inputs

| Input           | Where it comes from                                           |
| --------------- | ------------------------------------------------------------- |
| `classify.json` | `.signals.top_clusters`, `.signals.residue`, `.signals.mechanical_ratio` |
| `range`         | `review_worktree.py` JSON                                     |
| worktrees       | `.worktrees.base`, `.worktrees.head`                          |

`classify.py` has already clustered the hunks.
`.signals.top_clusters` holds the repeated token substitutions and their counts; `.signals.residue` holds the files with hunks that did not fit any cluster.
Trust those counts.
Your job is to characterise, not to recount.

## What to do

1. **Name the transformation.** State the repeated edit in one line, in terms a human can verify by eye.
2. **Sample it.** Show one representative hunk. One, not three.
3. **Check it is uniform.** Scan the clustered hunks for any that differ in a way the token clustering would not catch - a changed value alongside a rename, an edit applied in a semantically different context, a spot where the same substitution means something else.
4. **List the residue in full.** Every hunk that did not fit the pattern, with its location and one line on what it does instead. Never truncate this list; it is the reason the artifact exists.
5. **Flag the misses.** Places where the transformation looks like it *should* have been applied but was not. Omissions are invisible in a diff and are the classic wide-cut defect.

## What you must not do

Do not review the residue.
Describe what each residual hunk does and let the human judge it.

Do not re-list the mechanical hunks individually.
A count and one sample is the whole point.

## Output

````markdown
# Residue: <id>

**Transformation:** <the repeated edit, one line>
**Coverage:** <N> of <M> code hunks fit the pattern (mechanical ratio <ratio>)

## Sample

```diff
<one representative hunk>
```

## Residue - <K> hunks that do not fit

### `<path>:<line>`
<one or two lines on what this hunk does instead of the pattern>

<Repeat per residual hunk. Complete, never truncated.>

## Possible omissions

- `<path>:<line>` - <where the pattern appears to apply but was not used>

<Write "None found" if there are none. Say how you looked, in one line, so the
reviewer knows how much weight the absence carries.>

## Uniformity check

<One or two sentences: did every clustered hunk really do the same thing, or
did any differ in a way the token clustering would not have caught?>
````
