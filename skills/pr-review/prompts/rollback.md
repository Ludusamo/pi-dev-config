# Prompt: Rollback

Produces `rollback.md`, generated only for `risky_surface` changes.

One question: if this is wrong in production, how fast can it be undone, and what does undoing it cost?

## Inputs

| Input           | Where it comes from                                          |
| --------------- | ------------------------------------------------------------ |
| `classify.json` | `.signals.risky_matches`, `.signals.migrations`, `.signals.contract_docs_changed` |
| `range`         | the diff                                                     |
| `head_worktree` | deployment and config files                                  |

Read the repository's own deployment documentation before writing anything.
Rollback mechanics are repo-specific and guessing at them produces confidently wrong advice, which is worse here than in any other artifact.
Look for CI/CD docs, a deployment section in the contributor guide, and how configuration reaches each environment.

## The question to answer

Not "can this be reverted in git" - almost anything can.
Ask what happens to **state and contracts** when the previous version runs again:

- **Schema.** Did anything change the database shape? Is the old code compatible with the new schema? Who owns migrations, and do they roll back separately from the application?
- **Contract.** Did a published interface change? If a consumer already adopted it, reverting breaks them, and the rollback is no longer a single-repo operation.
- **Persisted data.** Did this version write data the old version cannot read? That is the one genuinely irreversible category, and it deserves to be stated plainly.
- **Configuration.** Does reverting the code require reverting a config or secret too? A revert that silently needs a second manual step is a trap.
- **Partial deploy.** If rollback happens with both versions briefly live, does anything break in that window?

## Honesty

If the answer is "a straight redeploy of the previous tag, nothing else", say exactly that in one line and stop.
Most risky-surface changes are genuinely easy to roll back, and padding this artifact to look thorough trains the reviewer to skip it.

Where you cannot determine something from the repository, say so and name who would know.
Do not infer deployment behaviour from convention.

## Output

````markdown
# Rollback Notes: <id>

**Why this is flagged:** <which risky surface matched, one line>

**Verdict:** <clean revert | revert plus steps | not cleanly reversible>

## Procedure

1. <the actual steps, in order>

## Blockers to a clean revert

| Concern | Applies? | Detail |
| ------- | -------- | ------ |
| Schema change | no | <one line> |
| Published contract change | yes | <one line> |
| Data written in a new shape | no | <one line> |
| Config or secret change | no | <one line> |
| Mixed-version window | no | <one line> |

<Keep every row even when the answer is no - the "no"s are what make the
"yes"es trustworthy.>

## Point of no return

<The moment after which revert stops being clean - first write in the new
shape, first consumer adopting the contract, migration applied. Write "None"
if the change stays reversible indefinitely.>

## Unknown

<What you could not determine from the repository, and who would know.
Write "Nothing" if the picture is complete.>
````
