# Prompt: Flow Diff

Produces `flow.md`: how the logic flowed before, how it flows after, and the delta between them.

Generated for `narrow_behavioural` and above.
This is the artifact that answers "what actually changes at runtime", which a diff shows only indirectly.

## Inputs

| Input           | Where it comes from                                  |
| --------------- | ----------------------------------------------------- |
| `base_worktree` | `.worktrees.base` - read whole files as they were     |
| `head_worktree` | `.worktrees.head` - read whole files as they are      |
| `range`         | for `git diff`                                        |
| `classify.json` | `.signals.residue` and `.signals.subsystems` point at where the behaviour moved |

Read both worktrees.
A flow diff built from the unified diff alone will miss the surrounding control flow, which is usually where the meaning lives.

## Scope

Diagram **one** flow: the primary path the change alters.
If the change genuinely alters two unrelated flows, produce two small diagrams rather than one combined diagram that shows neither clearly.

Stay at the level of "what happens in what order, and what decides it".
Do not diagram every method call - that is the call graph's job.
Nodes should be steps a reviewer would recognise: a validation, a branch, an upstream call, a transformation, an error path.

Cap each diagram at roughly a dozen nodes.
If it will not fit, you are diagramming too wide a scope - narrow to the part that changed.

## Error and edge paths

Include them.
A flow diagram that shows only the happy path hides exactly the change most likely to be wrong.
Null handling, timeouts, empty results and thrown exceptions are nodes, not footnotes.

## Drawing

ASCII only, inside a fenced block, assuming a monospace font.
No mermaid, and no box-drawing characters - plain ASCII renders everywhere these artifacts get read, including a terminal, a diff view and a GitLab comment box.

Conventions:

- Boxes are `+---+` corners, `-` horizontals, `|` verticals.
- Flow runs top to bottom. `|` continues an edge, `v` ends it.
- Branch labels sit on the edge: `-- null -->`.
- Keep the whole diagram under 90 columns so it does not wrap.
- A step that did not change is written plainly; a step that changed is marked with `*` before its label.

```
      +---------------------------+
      |  GET /trades/{id}/fills   |
      +---------------------------+
                   |
                   v
      +---------------------------+
      |  TradeServiceClient       |
      |  .fills(tradeId)          |
      +---------------------------+
           |                 |
       ok  |                 | timeout
           v                 v
  +-----------------+   +--------------------------+
  | * map FillView  |   | cod.blotter.upstream_... |
  |   (21 fields)   |   | 504 ProblemDetail        |
  +-----------------+   +--------------------------+
```

For a loop or retry, draw the back edge on the left margin with `<` and a note:

```
  +---------------+
  |  attempt call |<--+
  +---------------+   |
          |           | retry x3
          v           |
     [ failed? ] -----+
```

If a flow genuinely cannot be drawn clearly in under 90 columns, it is too wide a scope - narrow it to the part that changed rather than shrinking the labels.

## Output

````markdown
# Flow Diff: <id>

**Flow:** <which path this traces, e.g. "GET /api/v1/trades/{id}/fills, request to response">

## Before

```
<ascii diagram>
```

## After

```
<ascii diagram, with changed steps marked *>
```

## What changed

| Step | Before | After |
| ---- | ------ | ----- |
| <step name> | <behaviour> | <behaviour> |

<Only rows that differ. This table is what most readers will actually use;
the diagrams are there to give it context.>

## Paths that did not change

<One line. Useful negative information - it tells the reviewer what they can
skip, which is the point of the whole exercise.>

## Unverified

<Anything in the diagrams you inferred rather than read, especially upstream
behaviour you cannot see from this repository. Write "Nothing" if the whole
flow was read from source.>
````

## What you must not do

Do not assert that either flow is correct.
Show what happens; the reviewer decides whether it should.

Do not invent intermediate steps to make a diagram look complete.
If you cannot tell what happens between two points, say so in "Unverified" and draw the edge directly.
