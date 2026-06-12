---
name: deepen
description: 'Strengthen a single vault note with research. Usage: /learning-loop:deepen "note name" or /learning-loop:deepen (picks shallowest inbox note). Assesses maturity, researches gaps, rewrites in vault voice, promotes when ready.'
---

# Deepen: Research and Enrichment

## Overview

Launches the `note-deepener` agent to strengthen a single note. The agent assesses maturity, researches gaps scaled to need, rewrites in persona voice, verifies sources, and promotes when ready. Shallow notes get heavy research; deep notes get a light touch.

## When to Use

- `/deepen <note-name>`: target a specific note
- `/deepen`: no argument; picks the shallowest inbox note
- When `/inbox` flags a note as needing deepening
- When a note feels thin and the user wants to strengthen it

## Provenance

This skill emits provenance events for pipeline observability. Run each Bash command silently.

**At session start:**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/provenance-emit.js" '{"agent":"deepen","skill":"deepen","action":"session-start","target":"NOTE_FILENAME"}'
```

**At session end:**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/provenance-emit.js" '{"agent":"deepen","skill":"deepen","action":"session-end","target":"NOTE_FILENAME","promoted":true|false}'
```

Per-note tracking is handled automatically by the PostToolUse hook.

## Process

### Step 0: Parameter Resolution

**No argument (`/deepen`):**
Run auto-pick immediately (the agent picks the shallowest inbox note — no prompting needed). After presenting results, mention the targeted form in one line:

> Deepened [note]. To target a specific note: `/deepen "note name"`.

**Argument provided:**
Proceed immediately.

### Step 1: Launch Agent

Launch the `note-deepener` agent with:
- **note_path**: Path to the target note (resolve via `Glob` if only a name was given)
- **vault_path**: `{{VAULT}}/`

The agent definition is at `${CLAUDE_PLUGIN_ROOT}/agents/note-deepener.md` (resolve to a literal path before dispatch — see `agents/_skills/vault-io.md` → Placeholders).

If no note name was provided, pass no note_path: the agent will pick the shallowest inbox note.

### Step 1.5: Replay Post-Write Hooks

The `note-deepener` is a subagent. Its Write/Edit tool calls bypass PostToolUse, so the deepened note (and any split note in `0-inbox/`) misses the `hooks/post-tool.js` dispatcher (autolink + edge-infer modules).

Run the unlinked-body sweep from `${CLAUDE_PLUGIN_ROOT}/skills/_shared/hook-replay.md` (read it and execute; seed the candidate list with the destination path — and any split-note paths — from the agent's report, then it backfills via the unlinked-body walk and replays the hook chain on each). Idempotent: safe on already-hooked notes.

Report failures in Step 2 if any.

### Step 2: Present Results

The agent returns a structured report with before/after comparison, maturity transition, and destination. Present it to the user.

If the agent flagged uncaptured sources, suggest `/literature` for each.

## Resolving Verification Markers

If the note contains verification markers, prioritize resolving them. The canonical marker vocabulary and per-marker resolution rules live in `agents/_skills/capture-rules.md` → Verification Markers — read that section rather than relying on a local list; it covers all of `[unresolved]`, `[unverified]`, `[not in abstract]`, `[not in source]`, `[needs verification]`, `[citation needed]` (blocking) and `[partial]` (advisory). For `[unverified]`, the inspection command is `node ${CLAUDE_PLUGIN_ROOT}/scripts/source-resolver.mjs verify-note <path>`. Remove each marker only once its resolution rule is satisfied.

## Key Principles

- **The skill is thin.** All logic lives in the `note-deepener` agent and its `_skills/`.
- **Scale effort to need.** The agent handles this automatically via promote-gate assessment.
- **Promotions are autonomous.** The agent promotes based on quality: no approval needed.
- **Splits go to inbox.** If the agent found two ideas, the second lands in `0-inbox/`.
