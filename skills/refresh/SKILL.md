---
name: refresh
description: 'See what you already know about a topic (no web research). Usage: /learning-loop:refresh "topic". Searches vault notes, episodic memory, and literature. Optionally tests discrimination of confusable note pairs. Good before /learning-loop:discovery or when returning to a topic.'
---

# Refresh — What Do I Already Know?

## Overview

Quick retrieval of everything the vault holds on a topic. No web research, no enrichment — just surfaces what's already captured. The inward-facing counterpart to `/discovery`.

## When to Use

- `/refresh "topic"` — what do I know about this?
- `/refresh` — no argument; ask what the user wants to recall
- Before starting `/discovery` — orient on existing knowledge first
- When returning to a project or domain after a break
- When you can't remember if you've captured something

## Process

### Step 1: Identify Topic

If a topic was provided, use it. If not, ask.

### Step 2: Launch Vault Scout

Use the `discovery-vault-scout` agent to search the vault and episodic memory:

```
SendMessage to discovery-vault-scout:
  "Search for everything we have on: <topic>"
```

The scout handles vault content search, filename matching, episodic memory, and project index checks in parallel. Wait for it to return results.

### Step 3: Read Top Matches

Read the top note matches from the scout's results (up to 10 notes). For each:
- One-line summary of what it captures
- Location (which vault folder — inbox, fleeting, literature, permanent, projects)
- Links it contains (what does it connect to?)

### Step 4: Present

Organize by knowledge depth, not by folder:

```
## What you know about: [topic]

### Strong knowledge (permanent / well-sourced)
- [[note-name]] — one-line summary
- [[note-name]] — one-line summary

### Working knowledge (fleeting / partially developed)
- [[note-name]] — one-line summary

### Raw captures (inbox / unprocessed)
- [[note-name]] — one-line summary

### Literature
- [[source-note]] — what it covers

### Past conversations
- [context]: key insight from episodic memory

### Connections
- These notes link to each other: [[a]] ↔ [[b]] ↔ [[c]]
- Related project: [[project-name]]
```

Omit empty sections silently. If nothing is found, say so plainly: "Nothing in the vault on this topic."

### Step 5: Suggest Next Action

Based on what was found:

| Finding | Suggestion |
|---------|-----------|
| Nothing found | "Run `/discovery` to start exploring" |
| Only raw inbox notes | "Run `/inbox` to triage, or `/deepen` on the strongest one" |
| Good coverage, some gaps | "Run `/discovery` to fill gaps, or `/deepen` on a specific note" |
| Strong coverage | "You know this well. Anything specific you want to revisit?" |

### Step 6: Discrimination Rounds (Optional)

If the vault scout's discrimination report found confusable pairs in this topic:

1. Read the discrimination skill: `{{PLUGIN}}/agents/_skills/discrimination.md`
2. Follow the **Interactive Mode** instructions from the skill
3. Present pairs one at a time (max 3 rounds)
4. Use folder-based difficulty:
   - Both in `3-permanent/` or `2-literature/` → Mode A (titles only, "what's the difference?")
   - Either in `0-inbox/` or `1-fleeting/` → Mode B (full notes, "is this distinction clear?")
5. After user responds, reveal both notes (if Mode A) and state the actual distinction
6. "skip" ends the discrimination section

If no confusable pairs were found, skip this section silently.

## Subagent Usage

| Agent | Purpose | When |
|-------|---------|------|
| `discovery-vault-scout` | Vault content/filename search, episodic memory, project index | Step 2 — always launched for the search phase |

## Key Principles

- **Read before summarizing.** Don't guess from titles alone — read the notes.
- **No enrichment.** This is retrieval, not research. Don't search the web. Don't rewrite notes.
- **Fast.** This should feel like checking your own notes, not waiting for a report.
- **Honest gaps.** If the vault is thin on a topic, say so. That's useful information.
- **No artifacts.** `/refresh` produces no new notes. It just shows what's there.
