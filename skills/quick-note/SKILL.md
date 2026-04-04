---
name: quick-note
description: 'Quick mid-conversation capture to inbox. Usage: /learning-loop:quick-note (infers from context), /learning-loop:quick-note "insight title", or /learning-loop:quick-note "title" "body". Writes to 0-inbox/ without breaking flow.'
---

# Quick Note — Zero-Friction Capture

## Overview

Captures a single insight to `0-inbox/` mid-conversation. No preview, no approval, no multi-agent pipeline. One subagent, one note, one confirmation line.

## When to Use

- `/learning-loop:quick-note` — infer the insight from conversation context
- `/learning-loop:quick-note "insight as title"` — user provides the title
- `/learning-loop:quick-note "title" "body"` — user provides everything

## Process

### Step 1: Extract the Insight

**If no args:** Read the recent conversation. Identify the most capture-worthy insight — a decision made, pattern discovered, or connection drawn. If nothing stands out, tell the user and stop.

**If title only:** Use it as the insight title. Derive body from conversation context.

**If title + body:** Use both as provided.

### Step 2: Delegate to Note Writer

Spawn a single `note-writer` subagent (subagent_type: `learning-loop:note-writer`) with this prompt:

```
Write a quick inbox note for the Obsidian vault.

Insight: <title>
Context: <body or conversation context summary, 2-3 sentences max>
Source project: <current project name or "conversation">
Date: <today YYYY-MM-DD>
Destination: 0-inbox/

Before writing, run this command to find related vault notes:
node PLUGIN/scripts/vault-search.mjs search "<key terms from insight>" --rerank

Use the top 1-3 relevant results as wiki-links in the note.

Write the note directly to {{VAULT}}/0-inbox/<filename>.md using the Write tool.
Return the filename and title when done.
```

### Step 3: Report

Show one line:

```
Captured: "Note Title" → 0-inbox/filename.md
```

Nothing else. No summary. No follow-up suggestions. Back to what we were doing.

## Key Principles

- **Speed over polish.** This is inbox. `/deepen` exists for a reason.
- **One subagent.** The note-writer handles vault search + write in one shot.
- **No confirmation.** Write and report. Inbox is low-stakes.
- **No context pollution.** Delegate to keep the main conversation clean.
- **Conversation context is the source.** When no args given, the LLM's view of the conversation is the raw material.
