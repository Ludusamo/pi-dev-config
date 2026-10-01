# REVIEW_STANDARDS.md format

The per-repo review standards file.
Lives at the repository root, versioned with the code, so a rule and the code it governs move together.

Three skills read it: `pr-review-prep` (risky surfaces + config), `pr-review` (the human-only checklist), and `pr-review-retro` (which rules earn their keep).
`classify.py` parses the `# Config` and `# Risky Surfaces` sections mechanically, so their shape matters.
The `# Rules` section is read by the scanner agent, so it only has to be unambiguous to a careful reader.

## Skeleton

````markdown
# Config

- subsystem_re: /cod/([^/]+)/
- shared_contract_globs: `**/model/entity/**`, `**/TradeViewRow.java`

# Rules

R-001: One-line imperative claim
- Active: true
- Applies when: <the trigger, in terms of paths or diff content>
- Check: <what a reviewer or agent actually verifies>
- Severity: blocker | nitpick | follow-up
- Checkable by: ai | human
- Evidence: <what must be cited to call it pass or fail>

# Risky Surfaces

- `src/main/java/**/security/**`
- Concurrency
````

## Sections

### `# Config`

Per-repo knobs, one `key: value` bullet each.
Currently honoured:

| Key                     | Meaning                                                                        |
| ----------------------- | ------------------------------------------------------------------------------ |
| `subsystem_re`          | Regex whose first capture group names the subsystem a path belongs to.           |
| `shared_contract_globs` | Comma-separated globs for types whose modification forces consumers to follow.   |

`subsystem_re` matters more than it looks.
It is what distinguishes "contained" from "spreads", which is the deep-cut test.
Get it wrong and every change looks like one subsystem.
In a layer-sliced repo, capturing the layer (`controller`, `service`, `model`) is usually wrong - every vertical feature touches three of them, so everything reads as spread out.

`shared_contract_globs` overrides the built-in heuristic, which treats anything under `model/`, `dto/`, `schema/` and friends as a shared contract.
That default is far too broad for a BFF or any repo whose normal work is mirroring upstream payloads.
List only the types where a change genuinely forces consumers to follow.
Note that appending to one of these files does not trigger a deep cut: only modifying or deleting existing lines does, because that is what breaks a consumer.

### `# Rules`

One entry per rule, each introduced by an ID line.

**ID.**
`R-NNN` plus a short imperative claim.
IDs are permanent and never reused: the retro loop refers to them across months of reviews, so recycling `R-007` silently corrupts the history.
Retire by setting `Active: false`, never by deleting.

**Active.**
`true` or `false`.
A retired rule stays in the file as a record of something that was once worth checking and stopped being worth it.
Only the retro loop should flip this, and only with ledger evidence.

**Applies when.**
The trigger, stated so it can be evaluated against a diff without reading the whole repo.
Prefer paths and diff content over intent: "a file under `controller/` changes" is checkable, "the author adds a feature" is not.
A rule with no trigger runs on every PR and will be ignored within a month.

**Check.**
The single thing being verified.
One claim per rule.
If the sentence needs an "and", it is two rules - split it, otherwise a partial failure has no honest verdict.

**Severity.**
What a failure means for the merge:

| Severity    | Meaning                                                      |
| ----------- | ------------------------------------------------------------ |
| `blocker`   | Do not merge until resolved.                                  |
| `nitpick`   | Worth a comment, author's discretion.                         |
| `follow-up` | Fine to merge, needs a ticket.                                |

Severity belongs to the rule because it is a standing policy decision.
An individual finding may be downgraded in the verdict, and that downgrade is a signal the retro should notice.

**Checkable by.**
`ai` or `human`.
This is the most load-bearing field in the format.
`ai` rules are evaluated by the scanner.
`human` rules are a mandatory checklist the reviewer works through regardless of what the scan said, because they depend on intent, external evidence, or judgement the model cannot source.

Mark a rule `human` when verifying it requires knowledge not present in the diff: whether a value was transcribed from a live payload, whether a product decision was actually ratified, whether a number is correct.

**Evidence.**
What must be cited for the verdict to count.
Usually `file:line`.
For `human` rules it may be a link or a named source.
A rule whose evidence cannot be named is not checkable - rewrite or drop it.

### `# Risky Surfaces`

A flat bullet list, parsed into two buckets automatically:

- **Globs** - wrap them in backticks. Matched against changed paths; a hit sets the risky-surface classification and pulls in rollback notes.
- **Topics** - bare prose like `Concurrency`, written without backticks. Cannot be path-matched, so they are passed to the scanner as explicit adjudication questions rather than silently dropped.

The backticks are load-bearing.
Bare filenames such as `Dockerfile` or `build.gradle` contain neither a slash nor a star, so without the backticks they are indistinguishable from prose and get filed as topics.

Prefer globs.
Reach for a topic only when the concern genuinely has no path, such as "Architectural".

## Authoring guidance

**Write rules from scars, not from principles.**
A rule earns its place because something went wrong, or a review comment keeps recurring.
Seeding a file with generic best practice produces noise that trains you to skim the scan output.

**Keep it falsifiable.**
"Error handling is appropriate" cannot fail honestly.
"Every `catch (InterruptedException)` restores the interrupt flag" can.

**Rules are cheap to add and expensive to keep.**
The retro loop exists to prune.
A rule that has never fired, or that fires and is wrong, should be retired - that is the mechanism that keeps reviews getting faster rather than slower.

**Encode the repo's weirdness, not the language's.**
Things a competent outsider would get wrong: the banned dependency, the file that must be regenerated, the layer that is forbidden to do arithmetic.
Generic style is the linter's job and should never appear here.

## Calibration

A classification signal is only useful if it discriminates.
Before trusting a new `# Risky Surfaces` list or `shared_contract_globs` setting, measure its hit rate across the last 30-40 commits on the main branch.

Rough targets:

| Signal                    | Healthy hit rate | If it is higher                                           |
| ------------------------- | ---------------- | --------------------------------------------------------- |
| Risky surface (whole list)| 10-30%           | Cut the surfaces that are the repo's normal working area.   |
| Deep cut                  | 10-30%           | Narrow `shared_contract_globs`.                             |
| Full-depth (4 artifacts)  | around 20%       | Both of the above.                                          |

A surface that fires on most MRs is not a warning, it is a description of the repo.
When that happens the concern usually belongs in a rule, which is targeted and produces a specific verdict, rather than in a risky surface, which just dials up the artifact count.

The practical test: if the classification mix comes out mostly "everything at maximum depth", the triage is doing no work and the review will not get faster.

## Lifecycle

1. A review produces points tagged with a RuleID, or marked `new`.
2. `new` points that recur twice become a candidate rule.
3. Rules that fire and are judged wrong twice get `Active: false`.
4. Rules that have never fired across N reviews get questioned.

Steps 2-4 are `pr-review-retro`'s job.
It proposes the edits; a human lands them, because this file is versioned with the code and the team reads it.
