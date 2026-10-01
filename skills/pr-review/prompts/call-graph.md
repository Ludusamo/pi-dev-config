# Prompt: Call Graph

Produces `callgraph.md`: who calls the changed code, and what the changed code calls.

Generated for `deep_cut` and `risky_surface`.
Its purpose is blast radius - showing the reviewer which untouched code is nevertheless affected.

## Inputs

| Input           | Where it comes from                                          |
| --------------- | ------------------------------------------------------------ |
| `head_worktree` | `.worktrees.head` - resolve callers and callees here, never in the main repo, which sits on an unrelated branch |
| `classify.json` | `.signals.shared_contracts[]` already has consumer counts and a sample |
| `range`         | the changed symbols                                          |

Use `git grep -n -w <symbol>` inside `head_worktree`.
Start from `.signals.shared_contracts[].sample` where it exists rather than rediscovering it.

## Direction matters

**Callers (inbound) are the point.**
These are files that did not change but may now behave differently.
This is the half that catches real defects, so spend the effort here.

**Callees (outbound)** matter only where the change introduces a *new* dependency - a new upstream call, a new service, a new shared helper.
Do not enumerate existing callees that were already there.

## Depth

Two levels of callers, no more.
Level 1 is direct callers; level 2 is their callers.
Past that the graph stops being readable and stops being useful.

Exclude test files from the graph itself.
Report them as a count per changed symbol instead - test callers tell you about coverage, not blast radius, and they swamp the diagram.

## Drawing

ASCII only, inside a fenced block, assuming a monospace font.
No mermaid, and no box-drawing characters.

A call graph is a tree, so draw it as an indented tree rather than as boxes - it stays readable at far more nodes:

- Callers hang off the changed symbol, indented one level per hop.
- `|-` for a sibling, `` `- `` for the last child, `|` to continue a vertical run.
- Mark each node `[changed]` or `[untouched]`. Untouched callers are the point of the artifact, so the marker carries the meaning.
- Append `(no test)` where no test reaches that caller.
- Keep lines under 90 columns; truncate a long path from the left with `...` rather than wrapping.

```
FillView [changed]  - 18 consumers, 2 components appended
|
|- TradeServiceClient.fills()            [untouched]
|  |- TradeBlotterController.fills()     [untouched]
|  `- CsvExportService.writeFills()      [untouched] (no test)
|
`- ...blotter/FillMapper.toView()        [changed]
   `- TradeDetailsService.detail()       [untouched]
```

## Output

````markdown
# Call Graph: <id>

**Changed symbols:** <list>

## Inbound - who is affected

```
<ascii tree>
```

| Caller | Symbol used | Changed in this MR? | Affected how |
| ------ | ----------- | ------------------- | ------------ |
| `path/File.java:88` | `FillView` | no | <one line> |

<Sort unchanged callers first - those are the ones nobody is looking at.>

## Not updated but arguably should be

- `<path>:<line>` - <why this caller might need to follow the change>

<The highest-value section. Write "None identified" and one line on how you
looked if there are none.>

## New outbound dependencies

- <only dependencies this change introduces; omit the section if there are none>

## Test callers

| Symbol | Test files referencing it |
| ------ | ------------------------- |
| `FillView` | 6 |

## Coverage of the blast radius

<One or two sentences: of the unchanged callers above, which are exercised by
a test that this MR touched, and which are not reached at all. This is the
sentence that tells the reviewer where to look hardest.>
````

## What you must not do

Do not claim a caller is broken.
State that it uses the symbol, whether it was updated, and let the reviewer judge.

Do not pad the graph with framework or library calls.
Only first-party code in this repository.
