---
name: inbox
description: 'Batch triage inbox notes and sweep fleeting for archival. Usage: /learning-loop:inbox (no args). Classifies intention status (intentioned/resolved/limbo), clusters by topic, auto-promotes mature notes, surfaces top-5 limbo notes for close-or-plan decision, sweeps 1-fleeting/ for promoted/stale notes to archive, recommends merge/deepen/delete for the rest (asks before destructive actions).'
---

# Inbox — Batch Triage and Processing

## Overview

Launches the `inbox-organiser` agent to process all notes in `0-inbox/`. The agent clusters by topic, assesses maturity via the promote-gate skill, detects counter-arguments, and executes promotions autonomously. Merges and deletes require approval.

## When to Use

- Inbox has accumulated notes that need triage
- After a series of `/reflect` sessions that deposited notes
- When the user asks to clean up, process, or triage the inbox

## Provenance

This skill emits provenance events for pipeline observability. Run each Bash command silently.

**At session start:**
```bash
PLUGIN/scripts/provenance-emit.js '{"agent":"inbox","skill":"inbox","action":"session-start"}'
```

**At session end:**
```bash
PLUGIN/scripts/provenance-emit.js '{"agent":"inbox","skill":"inbox","action":"session-end","promoted":N,"deleted":N,"merged":N,"limbo":N}'
```

Per-note tracking is handled automatically by the PostToolUse hook.

## Process

### Step 1: Launch Agent

Launch the `inbox-organiser` agent with:
- **vault_path**: `{{VAULT}}/`
- **scope**: `all` (or `topic:<name>` if the user specified a topic filter)

The agent definition is at `PLUGIN/agents/inbox-organiser.md`.

Use `subagent_type: "learning-loop:note-scorer"` with the full prompt from the agent definition, or launch as a general-purpose agent that reads the agent file.

### Step 2: Handle Gated Actions

When the agent returns, it will list any actions needing approval (merges, deletes). Present these to the user and wait for confirmation. Execute approved actions.

### Step 3: Report

The agent returns a structured summary. Present it to the user.

## Key Principles

- **The skill is thin.** All logic lives in the `inbox-organiser` agent and its `_skills/`.
- **Promotions are autonomous.** No approval needed.
- **Destructive actions are gated.** Merges, deletes, and fleeting archival need explicit user approval.
- **Counter-arguments get promoted, not suppressed.** Quality determines folder.
- **Fleeting sweep runs after inbox.** Archives promoted notes (2+ permanent refs) and stale project notes (0 refs, 60+ days old) to `_archive/1-fleeting/`.
