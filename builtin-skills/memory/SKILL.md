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
under `../shared/memory/` only when its one-line hook looks relevant to the
current task; the hook is the only signal you get before reading, so the body
files are not in your prompt.

A recalled fact reflects what was true when it was written, not necessarily
now. If it names a file, command, config key, or flag, verify that still
exists before you rely on or recommend it — the code may have moved on.

## Save

Save durable knowledge — a user preference, a fact about the environment, a
decision and its reason, a procedure that will be reused. Do NOT save:

- session-specific details, or anything easily re-derived
- what the repository already records on its own — code structure, file
  layout, past fixes, git history, `CLAUDE.md`. If asked to remember one of
  these, ask what was non-obvious about it and save that instead.

1. Run `mkdir -p ../shared/memory/` first — on the first save in a channel
   this directory does not exist yet, and writes (or an `ls` to look around)
   will fail with `No such file or directory`.
2. Write one fact per file: `../shared/memory/<short-kebab-case-slug>.md`.
   Keep it short. Classify what kind of fact it is and shape the body to match:
   - **user** — who the user is (role, expertise, preference): state the fact.
   - **feedback** — guidance on how you should work (a correction, a confirmed
     approach): state it, then add a `**Why:**` line and a `**How to apply:**`
     line.
   - **project** — ongoing work, goals, or constraints not derivable from the
     code: state it (convert relative dates to absolute), then `**Why:**` /
     `**How to apply:**`.
   - **reference** — a pointer to an external resource (URL, dashboard,
     ticket): just the pointer and what it is for.

   Link related facts inline with `[[other-slug]]` (the other file's slug). A
   link to a slug that does not exist yet is fine — it marks a fact worth
   writing later.
3. Append a one-line pointer to `../shared/memory/MEMORY.md`:
   `- [title](<slug>.md) — one-line hook`. This hook is the ONLY thing a
   future session sees when deciding whether to open the file (the body is not
   injected), so make it specific enough to judge relevance from — name the
   concrete subject, not just the category.
4. Before adding, check MEMORY.md for an existing entry that covers the same
   topic — update that file instead of creating a near-duplicate. Delete
   entries that turn out to be wrong.

## Reusable procedures as skills

When a procedure is worth automating (a sequence of commands you would
repeat), save it as a skill instead: `../shared/skills/<name>/SKILL.md` with
YAML frontmatter (`name`, `description`). Skills placed there are loaded
automatically in future sessions in this channel.
