---
name: literature
description: 'Capture an external source as a literature note. Usage: /learning-loop:literature <URL> or /learning-loop:literature "paper title". Fetches content, extracts core ideas in vault voice, writes to 2-literature/ with vault links.'
---

# Literature — Source Material Capture

## Overview

Launches the `literature-capturer` agent to capture an external source as a literature note. The agent fetches the source, extracts core ideas in persona voice, finds vault connections and counterpoints, verifies claims, and writes to `2-literature/`.

## When to Use

- `/literature <URL>` — fetch and capture a web source
- `/literature <paper title or citation>` — search for and capture an academic source
- `/literature` — no argument; asks the user what to capture
- When `/deepen` flags uncaptured sources worth preserving

## Process

### Step 0: Parameter Resolution

**No argument (`/literature`):**
Use `AskUserQuestion`:

> What source would you like to capture?
>
> - **A URL** — I'll fetch and extract core ideas
> - **A paper title or citation** — I'll search for it first

**Argument provided:**
Proceed immediately.

### Step 1: Launch Agent

Launch the `literature-capturer` agent with:
- **source**: The URL, title, or citation provided by the user
- **vault_path**: `{{VAULT}}/`

The agent definition is at `PLUGIN/agents/literature-capturer.md`.

### Step 2: Handle Backlink Offers

The agent may identify existing vault notes that reference the source without wiki-links. Present these to the user and execute approved edits.

### Step 3: Present Results

The agent returns a structured report with the captured note, connections, counterpoints, and related sources. Present it to the user.

## Key Principles

- **The skill is thin.** All logic lives in the `literature-capturer` agent and its `_skills/`.
- **Literature captures the source, not commentary.** Reactions go in separate notes.
- **Backlink edits need approval.** Never modify notes outside `2-literature/` without asking.
- **Update over create.** If a literature note already exists for this source, update it.
