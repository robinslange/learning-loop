---
name: quick-note
description: 'Quick mid-conversation capture to inbox. Usage: /learning-loop:quick-note (infers from context), /learning-loop:quick-note "insight title", or /learning-loop:quick-note "title" "body". Writes to 0-inbox/ without breaking flow.'
---

# Quick Note: Zero-Friction Capture

## Overview

Captures a single insight to `0-inbox/` mid-conversation. No preview, no approval, no multi-agent pipeline. One subagent, one note, one confirmation line.

## When to Use

- `/learning-loop:quick-note`: infer the insight from conversation context
- `/learning-loop:quick-note "insight as title"`: user provides the title
- `/learning-loop:quick-note "title" "body"`: user provides everything

## Process

### Step 1: Extract the Insight

**If no args:** Read the recent conversation. Identify the most capture-worthy insight: a decision made, pattern discovered, or connection drawn. If nothing stands out, tell the user and stop.

**If title only:** Use it as the insight title. Derive body from conversation context.

**If title + body:** Use both as provided.

### Step 2: Delegate to Note Writer

Spawn a single `note-writer` subagent (subagent_type: `learning-loop:note-writer`) with this prompt (resolve `${CLAUDE_PLUGIN_ROOT}` to a literal path before dispatch — see `agents-shared/vault-io.md` → Placeholders):

```
Write a quick inbox note for the Obsidian vault.

Insight: <title>
Context: <body or conversation context summary, 2-3 sentences max>
Source project: <current project name or "conversation">
Date: <today YYYY-MM-DD>
Destination: 0-inbox/

Before writing, run this command to find related vault notes:
node ${CLAUDE_PLUGIN_ROOT}/scripts/vault-search.mjs search "<key terms from insight>" --rerank

Use the top 1-3 relevant results as wiki-links in the note.

Write the note to its destination using the Write tool, then report the exact written path.
Return the filename, title, and the written path when done.
```

This is a capture, not a promotion: leave `destination_locked` unset so a genuinely gate-worthy note can still be promoted out of `0-inbox/` by the gate. The note may therefore land in `1-fleeting/` or `3-permanent/` rather than `0-inbox/` — so do NOT assume the folder; read the path the agent reports.

### Step 2.5: Replay Post-Write Hooks

The note-writer is a subagent. Its Write call bypassed PostToolUse, so backlinks and edge inference didn't run. Replay them on the **exact path the agent reported** (the gate may have routed the note to a folder other than `0-inbox/`; a reconstructed `0-inbox/<filename>` path would point at a nonexistent file and the replay would silently fail):

```bash
printf '%s\n' "$NOTE_PATH" \
  | node "${CLAUDE_PLUGIN_ROOT}/scripts/sweep-hook-replay.mjs" --stdin
```

Where `$NOTE_PATH` is the absolute path built from the `Written:` line in the agent's response — never reconstructed from the requested destination. See `skills/_shared/hook-replay.md` for context.

### Step 3: Report

Show one line, using the actual folder the agent wrote to (read it from the agent's reported path):

```
Captured: "Note Title" → <actual-folder>/filename.md
```

Nothing else. No summary. No follow-up suggestions. Back to what we were doing.

## Key Principles

- **Speed over polish.** This is inbox. `/deepen` exists for a reason.
- **One subagent.** The note-writer handles vault search + write in one shot.
- **No confirmation.** Write and report. Inbox is low-stakes.
- **No context pollution.** Delegate to keep the main conversation clean.
- **Conversation context is the source.** When no args given, the LLM's view of the conversation is the raw material.
