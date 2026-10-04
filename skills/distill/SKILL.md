---
name: distill
description: Distills part of the current conversation, a file, a diff, or other material into a standalone Markdown handoff document in the OS temp directory so another agent can pick it up. Works like compaction, but targeted and written to disk instead of replacing context. Use when the user asks to distill, summarize, extract, condense, or write up something for another agent, or asks for a handoff document, briefing, or context file to pass along.
---

# Distill

Takes what the user asks for, works out what they want distilled, and writes it as a self-contained Markdown file in the temp directory.
Think of it as compaction with a target: the current context is left alone, and the output is a file another agent can read cold.

## 1. Determine the target

Work out what the user wants distilled from their request and the surrounding context.
Typical targets:

- The whole conversation so far, or a specific thread or topic within it.
- A decision, investigation, or debugging trail.
- One or more files, a diff, a PR, or a directory.
- Command output, logs, or research results gathered in this session.

If the target is clear enough to act on, proceed without asking.
Ask a single short clarifying question only if the target is truly ambiguous and a wrong guess would waste real effort.
Do not ask about format, length, or filename. Use the defaults below.

Read any files or sources the target depends on before writing.
Do not invent details. If something is unknown, put it under open questions.

## 2. Choose the output path

Resolve the temp directory in this order:

1. `$TMPDIR`
2. `$TEMP`
3. `$TMP`
4. `/tmp`

Use the first one that is set and non-empty.
Name the file `distill-{slug}-{timestamp}.md`.

- `slug`: 2 to 5 lowercase words from the topic, joined by hyphens, ASCII letters and digits only.
- `timestamp`: `YYYYMMDD-HHMMSS` in local time, for example `date +%Y%m%d-%H%M%S`.

Example: `/tmp/distill-auth-refactor-findings-20261004-143012.md`.
Never overwrite an existing file. The timestamp keeps names unique.

## 3. Write the document

Write for a reader with no access to this conversation.
Use absolute paths, exact identifiers, and exact commands.
Keep it as short as the content allows, but do not drop details the next agent would need.
Put each full sentence on its own line.
Do not use em dashes or emojis.

Use this structure and omit a section only if it is truly empty:

```markdown
# {Title}

## Source and request
Where this came from (session, files, PR, branch, date) and what the user asked for.

## Summary
A short paragraph or a few bullets giving the whole picture.

## Key details
Facts the next agent needs: file paths, function names, commands, errors, numbers, findings.

## Decisions and constraints
What was decided and why.
Requirements, limits, and preferences that must be respected.

## Open questions
Unknowns, risks, and things that need verification or user input.

## Next steps
A concrete, ordered list of what the next agent should do first.
```

## 4. Report back

After writing, tell the user:

- The exact absolute path of the file.
- A brief summary of its contents (a few lines: the title, the main points, and the next steps).

Do not paste the whole document into the reply.
Do not commit or move the file unless asked.
