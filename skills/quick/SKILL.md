---
name: quick
description: 'Fast verified answer to a question with vault context. Usage: /learning-loop:quick "question" or /learning-loop:quick (infers from context). One-shot: web research + vault awareness + auto-capture if novel.'
---

# Quick — Fast Verified Answers

## Overview

Answer a question quickly with web research, vault awareness, and source verification. One shot, no interactive rounds. Auto-captures noteworthy answers to the vault.

## When to Use

- `/learning-loop:quick "how much have jaguar prices dropped recently?"` — direct question
- `/learning-loop:quick` — infer question from conversation context

## Process

### Step 1: Parse the Question

**If args provided:** Use as the question.

**If no args:** Read recent conversation. Identify the question being discussed. If no clear question, ask the user with `AskUserQuestion`.

### Step 2: Parallel Research

Launch both subagents simultaneously:

**Vault Scout** (`discovery-vault-scout`):
```
Search the vault for what the user already knows about this topic.

Topic: <question keywords>
Vault path: {{VAULT}}/
Angle: <the specific question being asked>

Return relevant notes with content, and identify gaps.
```

**Researcher** (`discovery-researcher`):
```
Answer this specific question with web research.

Topic: <the question>
Depth: shallow
Existing knowledge: (empty — vault results not available yet)

Focus on answering the question directly, not mapping the landscape.
Find 2-3 sources. Source-resolve any academic claims.
Return: direct answer, supporting evidence, sources with metadata, confidence level.
```

### Step 3: Synthesize Answer

Merge vault-scout and researcher results into a direct answer.

**Structure:**
- If vault has relevant notes, lead with what the user already knows and how the new info extends or updates it
- If vault contradicts web findings, flag it explicitly: "Your note X says Y, but recent evidence shows Z"
- If vault has nothing relevant, lead with the web findings
- Keep it to 3-10 sentences. Cite sources inline.
- End with confidence: high (multiple concordant sources), medium (single source or mixed), low (sparse evidence, flag uncertainty)

**Tone:** Conversational. Plain language. No hedging paragraphs — if uncertain, one line says so.

### Step 4: Auto-Capture Gate

Evaluate silently in the main thread. Do not ask the user.

**Novelty check:** Compare researcher findings against vault-scout results. If the vault already covers >80% of the answer's substance, skip capture.

**Substance check:** Is the core insight a durable pattern, mechanism, or decision-relevant fact? If it's transient (today's weather, a live score, a price that will change next week), skip capture.

**If both pass:** Spawn a `note-writer` subagent (subagent_type: `learning-loop:note-writer`):
```
Write an inbox note for the Obsidian vault.

Insight: <the core durable insight from the answer>
Research: <researcher's findings with sources>
Related notes: <vault-scout's relevant note paths>
Source project: "conversation"
Date: <today YYYY-MM-DD>
Destination: 0-inbox/

Write the note directly to {{VAULT}}/0-inbox/<filename>.md using the Write tool.
Return the filename and title when done.
```

**If either fails:** No capture. Move to report.

### Step 5: Report

One line:

```
Quick: "question" | Captured: "Note Title" → 0-inbox/filename.md
```

or

```
Quick: "question" | No capture (already known)
```

or

```
Quick: "question" | No capture (transient)
```

Then done. No follow-up suggestions. No source handoff. Back to what we were doing.

## Subagent Usage

| Agent | Model | Role |
|-------|-------|------|
| discovery-vault-scout | Haiku | Keyword search + similar-note fan-out |
| discovery-researcher | Sonnet | 2-3 web searches + source verification |
| note-writer (conditional) | Sonnet | Atomic note in persona voice |

All agents exist. No new agents needed.

## Key Principles

- **One shot.** No interactive rounds, no steering, no "what angle interests you?"
- **Answer the question.** Not "here's the landscape." Direct answer with evidence.
- **Vault-integrated.** Weave existing knowledge into the answer naturally.
- **Auto-capture.** Novel durable insights get captured silently. No prompting.
- **Fast.** Shallow research depth. Two parallel agents. Minimal main-thread work.
- **Honest.** If evidence is thin, say so in one line. Don't hedge for three paragraphs.
