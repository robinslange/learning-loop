---
name: reflect
description: 'End-of-session consolidation. Usage: /learning-loop:reflect (no args). Reviews conversation, extracts learnings, routes to auto-memory or vault, cross-links projects, promotes inbox notes. Run after substantial work sessions.'
---

# Reflect — Learning Consolidation

## Overview

Structured checkpoint that extracts what was learned in this session and persists it to the right stores. This is how the learning loop closes — without this step, knowledge captured during the session rots.

## When to Use

- End of a substantial work session (any domain — code, research, theorycrafting, coaching, anything)
- When the Stop hook nudges you
- When the user explicitly asks to consolidate or reflect
- After receiving multiple corrections in a session

## Provenance

This skill emits provenance events for pipeline observability. Run each Bash command silently.

**At session start:**
```bash
{{PLUGIN}}/scripts/provenance-emit.js '{"agent":"reflect","skill":"reflect","action":"session-start"}'
```

**At session end:**
```bash
{{PLUGIN}}/scripts/provenance-emit.js '{"agent":"reflect","skill":"reflect","action":"session-end","vault_notes":N,"auto_memories":N}'
```

Per-note tracking is handled automatically by the PostToolUse hook.

## Process

Work through these steps in order. Be concise throughout — the vault voice is Hemingway, not Tolstoy.

### Step 1: Session Review

Silently review the conversation. Identify:
- **Domain**: What area of work/knowledge was this? (project name, topic area)
- **Nature**: Was this building, debugging, researching, deciding, learning, discussing?
- **Substance**: Rate the session — was it routine or did genuine learning happen?

If the session was purely routine (config change, typo fix, quick lookup), say so and skip to Step 5. Not every session produces learnings.

### Step 2: Extract Learnings

Identify what was learned. Categories:

| Category | Example | Destination | Confidence |
|---|---|---|---|
| **Correction received** | "Don't mock the DB in these tests" | Auto-memory (feedback) | strong |
| **Preference revealed** | "I prefer X approach over Y" | Auto-memory (user/feedback) | strong |
| **Decision made** | "We chose Postgres over SQLite because..." | Obsidian vault | - |
| **Problem solved** | "The build failed because X, fixed by Y" | Obsidian vault | - |
| **Pattern discovered** | "This pagination pattern works across projects" | Obsidian vault | - |
| **Domain insight** | "Resto Druid HoT uptime benchmarks are..." | Obsidian vault | - |
| **Project context** | "Auth rewrite is driven by compliance, not tech debt" | Auto-memory (project) | medium |
| **Cross-project connection** | "Same caching problem exists in Kinso and Solenoid" | Obsidian vault + links | - |
| **Implicit pattern** | User always runs tests before committing (observed 3+ times, never stated) | Auto-memory (feedback) | weak |

List each learning as a single line.

### Step 2.5: Batch Retrieval

Run a single retrieval call for all learnings identified in Step 2. Pass each learning summary as a query:

```bash
node {{PLUGIN}}/scripts/vault-search.mjs reflect-scan "learning 1 summary" "learning 2 summary" ... --top 5
```

Parse the JSON result. For each query:
- `top_match_similarity > 0.90`: likely duplicate. Read the existing note and update it instead of creating a new one.
- `top_match_similarity 0.70-0.90`: related note exists. Consider linking rather than duplicating.
- `top_match_similarity < 0.70`: no existing coverage. Create a new note.

Review `confusable_pairs` in the result. If any pairs are found, flag them for the user as potential MERGE or SHARPEN candidates in the Step 5 report.

### Step 2.75: Episodic Memory (optional)

If the episodic memory MCP tool is available (`mcp__plugin_episodic-memory_episodic-memory__search`), run one search for the session's primary topic/domain. Extract any relevant prior decisions or unresolved questions. If unavailable, skip silently.

### Step 3: Duplicate Check

Using the reflect-scan results from Step 2.5:
- For learnings with `top_match_similarity > 0.90`, read the matched note. If the existing note already captures the insight, skip creating a new one.
- For auto-memory items, search existing auto-memories by reading MEMORY.md and checking for overlap. Update rather than duplicate.

### Step 4: Write to Stores

**For auto-memory items:**
- Follow the auto-memory format (frontmatter with name, description, type + content)
- Set `confidence` in frontmatter based on signal strength:
  - `strong`: user explicitly stated the preference or correction ("I always want...", "Don't ever...", "No, do it this way")
  - `medium`: user corrected your output (changed X to Y, rejected an approach) or provided project context
  - `weak`: pattern inferred from repeated behavior (observed 3+ times but never explicitly stated by user)
- Existing memories without a confidence field default to `medium` throughout the system
- Feedback memories: lead with the rule, then Why and How to apply
- Project memories: lead with the fact, then Why and How to apply
- Update MEMORY.md index

**For Obsidian vault items:**
- Write to `{{VAULT}}/0-inbox/` using the `Write` tool
- Follow capture-rules.md: one idea per note, title states the insight, body 3-10 lines, max 3 tags, at least one link
- Follow persona.md voice: Hemingway + Musashi + Lao Tzu. No filler.
- Tag with source project/domain
- Link to the project index note in `4-projects/` if one exists

### Step 4.5: Intention Extraction

After writing new vault captures, scan each new note's body for intention patterns:
- "when working on X" / "when designing X" / "when building X"
- "use this for X" / "reference this for X"
- "apply to X" / "relevant to X"

If an intention pattern is found, extract to frontmatter:
```yaml
intentions:
  - "<extracted project/topic> — <the full intention sentence>"
status: intentioned
```

This ensures new notes with intentions appear in the next session's intention summary. Claude can drill into specific contexts on-demand.

### Step 5: Report

Output a brief summary:

```
Reflected on [domain/project] session.
Captured: [N items] → [where they went]
Connections: [any cross-project links made]
Merge/Sharpen candidates: [any confusable_pairs flagged, or "none"]
```

Keep it to 2-4 lines. The user can see the diffs if they want details.

### Step 6: Mark Reflection Complete

Write a timestamp so the Stop hook knows reflection already happened:

```bash
date +%s > /tmp/learning-loop-last-reflect
```

Run this via the Bash tool at the end of every /reflect invocation.

## Subagent Usage

None. All retrieval is handled by the `reflect-scan` binary command in the main thread.

## Key Principles

- **Not every session needs reflection.** Quick sessions get a quick "Nothing notable to capture."
- **Update over create.** Always check for existing notes/memories first.
- **Route correctly.** Behavioral stuff → auto-memory. Knowledge → vault. Don't mix them.
- **Voice matters.** Vault notes follow the persona. Short, sharp, linked.
- **Ask before restructuring.** Never promote, move, or edit notes outside `0-inbox/` without permission.
- **Cross-project transfer is the superpower.** The most valuable captures are patterns that apply beyond their origin project.
