---
name: memory
description: Persist knowledge across sessions and threads in this channel. Use when asked to remember something, when you learn a durable fact (user preference, environment detail, recurring procedure), or at the start of a task to recall what is already known.
---

# Channel memory

`../shared/` (relative to your working directory) is a persistent directory
shared by all sessions and threads in this channel. Memory lives in
`../shared/memory/`.

## Recall

The memory index (`../shared/memory/MEMORY.md`) is already included in your
system prompt — you do not need to read it yourself. Read the linked file
under `../shared/memory/` only when it looks relevant to the current task.

## Save

Save durable knowledge — user preferences, facts about the environment,
decisions, procedures that will be reused. Do not save session-specific
details or anything easily re-derived.

1. Write one fact per file: `../shared/memory/<short-kebab-case-slug>.md`.
   Keep it short; state the fact, why it matters, and how to apply it.
2. Append a one-line pointer to `../shared/memory/MEMORY.md`:
   `- [title](<slug>.md) — one-line hook`
3. Before adding, check MEMORY.md for an existing entry that covers the same
   topic — update that file instead of creating a near-duplicate. Delete
   entries that turn out to be wrong.

## Reusable procedures as skills

When a procedure is worth automating (a sequence of commands you would
repeat), save it as a skill instead: `../shared/skills/<name>/SKILL.md` with
YAML frontmatter (`name`, `description`). Skills placed there are loaded
automatically in future sessions in this channel.
