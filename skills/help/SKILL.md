---
name: help
description: 'Show all learning-loop commands with usage and modifiers. Usage: /learning-loop:help (no args).'
---

# Help — Learning Loop Commands

## Overview

Present the guide below when the user runs `/learning-loop:help` or asks what the learning loop can do. Adapt the level of detail to context — if they seem experienced, lean on the quick reference at the end. If they're new, walk them through the narrative.

## When to Use

- `/learning-loop:help` — show all commands
- When the user asks "what can the learning loop do?"
- When suggesting a next action and the user seems unsure of their options

## Output

Present this guide:

---

## Learning Loop

The learning loop turns conversations into lasting knowledge. Ideas start rough, get refined through research, and settle into permanent notes in your vault. Every command serves one of three jobs: **bringing ideas in**, **making them stronger**, or **keeping things tidy**.

### Start here

**Curious about something?** Run `/learning-loop:discovery`.

```
/learning-loop:discovery "spaced repetition"
```

It searches your vault for what you already know, researches the web for what you don't, and walks you through the topic interactively. You steer — it digs. At the end, key insights land in your inbox as atomic notes.

Want to just browse without saving anything? Add `--surf`:

```
/learning-loop:discovery "spaced repetition" --surf
```

Other options: `--depth shallow|medium|deep`, `--style guided|branch|checkpoint`, `--tone academic|conversational|persona`.

**Reading something good?** Run `/learning-loop:literature`.

```
/learning-loop:literature https://example.com/article
```

It fetches the source, extracts the core ideas, and writes a literature note to `2-literature/`. The source's ideas, captured clean — your commentary goes in separate notes that link back.

**Need a quick answer?** Run `/learning-loop:quick`.

```
/learning-loop:quick "how much have jaguar prices dropped recently?"
```

It searches your vault and the web in parallel, verifies key claims, and gives you a direct answer in 3-10 sentences. If the answer contains something novel and durable, it auto-captures a note to your inbox. No interactive rounds, no steering -- just a fast, sourced answer.

**Quick capture mid-conversation?** Run `/learning-loop:quick-note`.

```
/learning-loop:quick-note "insight as title"
```

It grabs the insight, finds vault links, and drops an atomic note in `0-inbox/`. No preview, no approval — just a one-line confirmation and back to work. Run it with no args and it infers the insight from conversation context.

**Finishing a work session?** Run `/learning-loop:reflect`.

It reviews what happened in the conversation, extracts anything worth keeping, and routes it to the right place — behavioral stuff to auto-memory, knowledge to your vault. This is how the loop closes. Without it, insights from the session evaporate.

### Making notes stronger

Notes land in `0-inbox/` as rough captures. Two commands move them forward:

**`/learning-loop:deepen`** takes a single note and strengthens it. It reads the note, scores its maturity, researches what's missing, rewrites it in vault voice, and promotes it when ready. Shallow notes get heavy research; deep notes get a light touch.

```
/learning-loop:deepen "note name"
```

**`/learning-loop:verify`** assesses both quality and source integrity. It scores each note on depth, sourcing, linking, and voice, then checks that cited sources are real and claims match what they say. Use it to find where to invest `/deepen` effort and catch fabricated references.

```
/learning-loop:verify inbox
/learning-loop:verify "distributed systems"
/learning-loop:verify permanent
```

### Challenging what you know

**`/learning-loop:gaps`** is the scientific method applied to your vault. It doesn't just find what's missing — it challenges what you believe. For any topic, it extracts your vault's claims, searches for counterarguments and criticisms, and surfaces tensions, absences, and thin ice. Findings are framed as questions, not verdicts. You decide what they mean.

```
/learning-loop:gaps "theanine"
/learning-loop:gaps
/learning-loop:gaps --sweep
```

Focused mode analyses a topic. No-argument mode auto-picks your densest unchallenged knowledge cluster. Sweep mode runs across the entire vault. Depth scales to note maturity — permanent notes get deep scrutiny. Counterpoint notes land in your inbox like any other knowledge, tagged `#counterpoint` and linked back to the challenged note.

### Keeping things tidy

**`/learning-loop:inbox`** is batch triage. It reads every note in your inbox, clusters them by topic, and recommends actions: promote, merge, deepen, or delete. Promotions happen automatically. Merges and deletes wait for your approval.

**`/learning-loop:health`** is your vault's status check. It scans for ghost duplicates, near-duplicate pairs, orphan notes, stale inbox entries, embedding gaps, and broken links. Light mode (default) gives you counts in seconds. `--deep` launches full analysis. `--auto` fixes the safe stuff without asking.

```
/learning-loop:health
/learning-loop:health --deep
/learning-loop:health --deep --auto
```

**`/learning-loop:refresh`** is pure recall — what does your vault already hold on a topic? No research, no new notes. Just surfaces what's there, organized by knowledge depth, and suggests what to do next.

```
/learning-loop:refresh "authentication patterns"
```

### Importing external context

**`/learning-loop:ingest`** pulls bulk context from external systems into your vault and auto-memory. Three sources supported:

```
/learning-loop:ingest linear                    # my assigned tickets
/learning-loop:ingest linear "AI Assistant"     # tickets from a specific project
/learning-loop:ingest repo ~/dev/kinso/monorepo # scan a repo
/learning-loop:ingest context                   # paste text to extract
```

It fetches the data, extracts atomic insights, previews them for your confirmation, then routes project-state to auto-memory and durable insights to `0-inbox/`. Run it when starting a new project, onboarding to a codebase, or pulling in work context from Linear.

### The natural flow

```
first time → /learning-loop:init       → vault path, persona, folder structure
external   → /learning-loop:ingest     → auto-memory + inbox notes
curiosity  → /learning-loop:discovery   → inbox notes  → /learning-loop:deepen  → permanent notes
question   → /learning-loop:quick      → answer + auto-capture if novel
reading    → /learning-loop:literature  → literature notes
mid-work   → /learning-loop:quick-note  → inbox note (don't break flow)
sessions   → /learning-loop:reflect    → inbox + auto-memory
cleanup    → /learning-loop:inbox      → promote, merge, or deepen
recall     → /learning-loop:refresh    → see what you know
quality    → /learning-loop:verify     → score quality + check sources → /learning-loop:deepen
challenge  → /learning-loop:gaps       → counterpoints + rewrites + /deepen queue
hygiene    → /learning-loop:health     → diagnose → route to /inbox, /verify, /deepen
```

### Quick reference

| Command | What it does |
|---------|-------------|
| `/learning-loop:init` | First-time setup: vault path, persona, folder structure |
| `/learning-loop:discovery "topic"` | Interactive research journey — explore something new or go deeper |
| `/learning-loop:quick "question"` | Fast verified answer — vault + web, auto-captures if novel |
| `/learning-loop:literature <URL>` | Capture an external source as a literature note |
| `/learning-loop:quick-note [title] [body]` | Quick capture to inbox — no args infers from context |
| `/learning-loop:reflect` | End-of-session — extract and persist learnings |
| `/learning-loop:deepen <note>` | Strengthen a single note with research |
| `/learning-loop:verify [scope]` | Score quality + verify sources, find what needs work |
| `/learning-loop:inbox` | Batch triage inbox notes |
| `/learning-loop:refresh "topic"` | Surface what you already know — no research |
| `/learning-loop:gaps "topic"` | Challenge vault knowledge — find tensions, thin ice, and missing perspectives |
| `/learning-loop:ingest [linear\|repo\|context]` | Pull external context into vault + auto-memory |
| `/learning-loop:health [--deep] [--auto]` | Vault hygiene dashboard — ghost dupes, orphans, stale notes, broken links |
| `/learning-loop:help` | This guide |

---

## Key Principles

- **Keep it scannable but useful.** Lead with the narrative for newcomers; the quick reference table is there for repeat visitors.
- **Update this when skills change.** If a new skill is added, add it here.
- **Suggest the right command.** When the user's intent is clear but they used the wrong skill, point them to the right one.
