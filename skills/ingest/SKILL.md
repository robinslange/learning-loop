---
name: ingest
description: 'Pull external context into the second brain. Usage: /learning-loop:ingest linear ["project"], /learning-loop:ingest repo [path], /learning-loop:ingest context, /learning-loop:ingest (prompts for source).'
---

# Ingest — External Context Import

## Overview

Pulls data from external sources (Linear, repositories, pasted text), extracts atomic insights, previews them for confirmation, then routes to auto-memory and/or vault notes.

## When to Use

- `/ingest linear` — pull my assigned Linear tickets
- `/ingest linear "Project Name"` — pull tickets from a specific project
- `/ingest linear --state "In Progress"` — filter by ticket state
- `/ingest repo ~/path/to/repo` — scan a repository
- `/ingest repo` — prompt for repo path
- `/ingest context` — prompt user to paste text
- `/ingest` — ask which source type

## Process

### Step 0: Parameter Resolution

Parse the source type from the first argument.

**No argument (`/ingest`):**
Use `AskUserQuestion`:

> What would you like to ingest?
>
> - **linear** — Pull Linear tickets (my assigned, or a specific project)
> - **repo** — Scan a repository for architecture and patterns
> - **context** — Paste text to extract insights from

**Source type provided:**
Parse remaining args as source-specific parameters.

### Step 1: Resolve Source Parameters

**Linear:**
- No additional args → scope = "me" (all assigned tickets)
- Quoted string arg → scope = that project name
- `--state "X"` → state filter
- Announce: "Pulling Linear tickets ({scope})..."

**Repo:**
- Path arg → use it
- No path → `AskUserQuestion`: "Which repository? (full path)"
- Verify path exists with `ls`
- Announce: "Scanning {path}..."

**Context:**
- `AskUserQuestion`: "Paste the text you'd like to ingest. I'll extract insights when you're done."
- Announce: "Extracting insights from pasted text..."

### Step 2: Launch Source Agent

Spawn the appropriate agent in the foreground:

**Linear:** Spawn a `general-purpose` agent with prompt:

```
Read the agent definition at {{PLUGIN}}/agents/ingest-linear.md and follow it exactly.

Scope: {scope}
State filter: {state_filter or "none"}
```

**Repo:** Spawn a `general-purpose` agent with prompt:

```
Read the agent definition at {{PLUGIN}}/agents/ingest-repo.md and follow it exactly.

Repo path: {repo_path}
```

**Context:** Spawn a `general-purpose` agent with prompt:

```
Read the agent definition at {{PLUGIN}}/agents/ingest-context.md and follow it exactly.

Source label: {source_label or "pasted text"}
Text:
{pasted_text}
```

### Step 3: Preview

Take the insights JSON returned by the agent.

Read `{{PLUGIN}}/agents/_skills/preview-format.md` and format the preview accordingly.

Display the preview to the user. Wait for confirmation via `AskUserQuestion`:

> Type numbers to exclude (e.g., "drop vault 2, 4"), or "all" to confirm everything, or "none" to cancel.

### Step 4: Filter

Parse the user's response:
- "all" → keep everything
- "none" → cancel, print "Ingest cancelled." and stop
- "drop vault 2, 4" → remove vault items 2 and 4
- "drop memory 1" → remove memory item 1
- Any other exclusion pattern → parse best-effort

### Step 5: Route

Determine the project name:
- Linear: infer from the most common project in the tickets, or ask
- Repo: derive from the repo directory name
- Context: ask via `AskUserQuestion` if not obvious

Spawn a `general-purpose` agent with prompt:

```
Read the agent skill at {{PLUGIN}}/agents/_skills/route-output.md and follow it exactly.

Project name: {project_name}
Vault path: {{VAULT}}/
Memory path: {memory_path}

Confirmed insights:
{confirmed_insights_json}
```

### Step 6: Summary

Display the routing agent's summary. Done.

## Key Principles

- **The skill is the UX layer.** Agents fetch and extract. The skill previews and routes.
- **Preview before write.** Never write to memory or vault without user confirmation.
- **Merge, don't overwrite.** Auto-memory files preserve manually-added context.
- **Vault notes go through note-writer.** Voice consistency matters.
- **One source per invocation.** To ingest from multiple sources, run the skill multiple times.
