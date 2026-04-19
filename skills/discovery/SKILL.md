---
name: discovery
description: 'Explore a topic interactively with web research and vault context. Usage: /learning-loop:discovery "topic" [--style guided|branch|checkpoint] [--tone academic|conversational|persona] [--surf]. --surf skips note creation.'
---

# Discovery — Interactive Research Journeys

## Overview

Guided exploration of a topic through iterative research and conversation. You steer, subagents dig. Each round presents findings and offers directions. The journey produces vault artifacts (or not — your choice).

## When to Use

- `/discovery "topic"` — cold start, curious about something new
- `/discovery "topic"` with existing vault notes — warm start, build on what you know
- `/discovery` — no argument; ask what the user is curious about
- After reading something that sparked questions
- To explore connections between existing vault notes

## Parameters

Parse from the invocation or ask the user. All have defaults.

| Parameter | Options | Default |
|-----------|---------|---------|
| **style** | `guided` / `branch` / `checkpoint` | `guided` |
| **tone** | `academic` / `conversational` / `persona` | `conversational` |
| **capture** | `full` / `surf` | `full` |

**Examples:**
- `/discovery "spaced repetition"` — all defaults
- `/discovery "spaced repetition" --style branch`
- `/discovery "spaced repetition" --surf` — lightweight, no artifacts until asked
- `/discovery --academic "CRISPR gene drives"`

## Styles

### Guided (default)
Socratic. Present findings, ask "what angle interests you?", dig deeper in that direction. One question at a time. Follow the user's curiosity.

### Branch
Choose-your-own-adventure. At each stage present 2-3 named branches with one-line descriptions. User picks. Follow that thread. Offer new branches at the next stop.

### Checkpoint
Research burst → synthesis → react. Less conversational, more "here's what I found, where next?" Good for deeper dives where the user wants substance before steering.

## Provenance

This skill emits provenance events for pipeline observability. Run each Bash command silently.

**At session start (after scope identified):**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/provenance-emit.js" '{"agent":"discovery","skill":"discovery","action":"session-start","intent":"TOPIC","config":{"style":"STYLE","capture":"MODE"}}'
```

**At session end (after all rounds complete):**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/provenance-emit.js" '{"agent":"discovery","skill":"discovery","action":"session-end","notes_created":N,"rounds":R}'
```

Per-note tracking is handled automatically by the PostToolUse hook.

## Process

### Step 0: Parameter Resolution

Use `AskUserQuestion` to help users discover and configure parameters. The goal is teaching the tool, not gatekeeping it.

**No topic provided (`/discovery`):**
Ask what the user is curious about. Include a brief mention of available options:

> What topic would you like to explore?
>
> Optional settings (all have sensible defaults):
> - **Style:** `guided` (Socratic, default) · `branch` (choose-your-own-adventure) · `checkpoint` (research burst then react)
> - **Tone:** `conversational` (default) · `academic` · `persona` (vault voice)
> - **Mode:** `full` (captures notes, default) · `surf` (explore only, no artifacts)

**Topic provided, no other params (`/discovery "topic"`):**
Proceed with defaults. Do NOT prompt — the user chose speed. Defaults are good.

**Topic + partial params (`/discovery "topic" --surf`):**
Proceed with provided params + defaults for the rest. Do NOT prompt for missing params — if they wanted to set them, they would have.

**Full params provided:**
Just run.

### Step 1: Orient

Spawn both subagents in the same turn (a single message with two Agent tool calls, not sequential):

1. **Vault Scout** (`discovery-vault-scout`): Search existing vault notes and episodic memory for what the user already knows about this topic.
   - Pass: topic, vault_path (`{{VAULT}}/`), angle (if any)

2. **Researcher** (`discovery-researcher`): Search the web for landscape overview.
   - Pass: topic, existing_knowledge (empty on first pass — vault scout results feed into subsequent rounds)

While agents work, confirm parameters with the user if any were ambiguous.

### Step 2: Present Orientation

Combine agent results. Present in the chosen tone:

**Conversational:** "Here's what you already know about X... and here's the landscape..."
**Academic:** Structured overview with terminology and source attribution.
**Persona:** Hemingway/Musashi/Lao Tzu voice throughout.

Include:
- What the vault already contains (from vault scout)
- The broader landscape (from researcher)
- Where the gaps are between known and unknown

Then, based on style:
- **Guided:** "What angle interests you most?"
- **Branch:** Present 2-3 named directions with one-line descriptions
- **Checkpoint:** Present the full research brief, then "Where next?"

### Step 3: Discovery Loop

Repeat until the user says "done", "wrap up", or similar:

1. **User steers** — picks a direction, asks a question, says "go deeper", or redirects
2. **Research** — launch `discovery-researcher` subagent with:
   - The new angle/question
   - `prior_rounds`: summary of what's been covered (prevent repetition)
   - `existing_knowledge`: vault scout findings + prior round findings
3. **Present** — deliver findings in chosen style and tone
4. **Capture** (if `full` mode) — after each round, write an inbox note for the key insight discovered. Keep it atomic, persona voice, properly linked. Include source URLs from the researcher's findings as clickable markdown links in the note body — don't defer URL capture to the wrap-up or `/literature` step. If the researcher returned a diagram, write it to `{{VAULT}}/Excalidraw/` and embed it in the trail note with `![[diagram-name]]`.

**Steering keywords the skill should recognize:**
- "go deeper" / "more on that" → same angle, increase detail
- "what about..." / "how does this relate to..." → new angle
- "back up" / "let's try another direction" → return to last branch point
- "done" / "wrap up" / "that's enough" → exit loop, go to Step 4

### Step 4: Wrap Up

**Full capture mode:**
- Individual inbox notes were written during the loop
- Write a synthesis note to `0-inbox/` that:
  - Title captures the overarching insight from the journey
  - Links to all trail notes created during the session
  - Summarizes what was learned in 5-10 lines, persona voice
  - Tags with topic domain, max 3 tags
  - Lists sources found

**Surf mode:**
- No notes were written during the loop
- Ask: "Want to capture anything from this journey?"
- If yes: let the user indicate what was valuable, write selective inbox notes
- If no: end cleanly, nothing persisted

**Both modes — source handoff:**
If noteworthy sources were found but not captured as literature notes:
```
Sources worth capturing (run /literature):
- "Source Title" — why it matters
- "Source Title" — why it matters
```

### Step 5: Report

```
Discovery: "[topic]"
Style: guided | Rounds: N
Captured: N notes → 0-inbox/
Synthesis: "Synthesis Note Title" → 0-inbox/
Sources found: N (run /literature to capture)
```

## Subagent Usage

### discovery-vault-scout
- Launch at Step 1 (orientation) and whenever the topic shifts significantly
- Pass topic, vault_path, and current angle
- Use results to ground the conversation in existing knowledge

### discovery-researcher
- Launch at Step 1 and each loop iteration
- Pass topic, angle, existing_knowledge, prior_rounds
- Search intensity is self-regulating via mechanical convergence detection
- Use results as the raw material for presentation
- **Internally spawns `note-verifier`** on its own findings before returning. Revises and re-verifies up to 3 times. All findings presented to the user are pre-verified.

**Always spawn agents in the same turn when they have no dependencies.** Vault scout and researcher have no dependencies on each other at orientation time. Use a single message with multiple Agent tool calls.

## Tone Guide

### Conversational (default)
Plain language. Analogies welcome. "Here's the intuition behind this..." — accessible, not dumbed down. Use this for the journey itself.

### Academic
Precise terminology. Source attribution inline. Caveats acknowledged. "The evidence suggests..." — rigorous but not dry.

### Persona
Hemingway/Musashi/Lao Tzu vault voice. Short sentences. No filler. Active voice. Present tense. Use sparingly for the journey — it's intense over long sessions.

**Regardless of journey tone, all vault artifacts are written in persona voice.** The journey is exploration; what sticks gets the Hemingway treatment.

## Key Principles

- **Follow curiosity, not curriculum.** The user steers. Don't impose a syllabus.
- **Never fabricate.** If agents can't find evidence, say so. Gaps are findings too.
- **Effort scales to the gap.** The researcher searches until mechanical convergence signals say it's found enough. Dense topics get more queries; sparse topics stop early. No manual depth tuning needed.
- **Vault-first.** Always check what's already known before going external. The most valuable discoveries connect new knowledge to existing understanding.
- **Atomic captures.** Each trail note is one idea. The synthesis note links them. Don't write monoliths.
- **Sources stay separate.** Flag sources for `/literature`. Don't create literature notes during discovery.
- **Surf mode is real.** Sometimes you just want to explore without committing to artifacts. Respect that.
- **Capture rules apply.** All vault notes follow capture-rules.md: insight title, 3-10 lines, max 3 tags, at least one link, persona voice.
