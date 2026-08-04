---
name: inbox
description: 'Batch triage inbox notes and sweep fleeting for archival. Usage: /learning-loop:inbox. Classifies intention status (intentioned/resolved/limbo), clusters by topic, auto-promotes mature notes, surfaces top-5 limbo notes for close-or-plan decision, sweeps 1-fleeting/ for promoted/stale notes to archive, recommends merge/deepen/delete for the rest (asks before destructive actions).'
---

# Inbox: Batch Triage and Processing

## Overview

Launches the `inbox-organiser` agent to process all notes in `0-inbox/`. The agent clusters by topic, assesses maturity via the promote-gate skill, detects counter-arguments, and executes promotions autonomously. Merges, deletes, and fleeting archival require approval.

## When to Use

- Inbox has accumulated notes that need triage
- After a series of `/reflect` sessions that deposited notes
- When the user asks to clean up, process, or triage the inbox

## Provenance

This skill emits provenance events for pipeline observability. Run each Bash command silently.

**At session start:**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/provenance-emit.js" '{"agent":"inbox","skill":"inbox","action":"session-start"}'
```

**At session end:**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/provenance-emit.js" '{"agent":"inbox","skill":"inbox","action":"session-end","promoted":N,"deleted":N,"merged":N,"rewrites":N,"limbo":N}'
```

Per-note tracking is automatic for main-thread writes via the PostToolUse hook; subagent writes and edits (note-writer files, the organiser's own Edits and mv-promotions) bypass it and are covered by the Step 2 hook replays (2a for note-writer output, 2c for the agent's touched-files inventory).

## Process

### Step 1: Launch Agent

Launch the `inbox-organiser` agent with:
- **vault_path**: `{{VAULT}}/`
- **scope**: `all` (or `topic:<name>` if the user specified a topic filter)

The agent definition is at `${CLAUDE_PLUGIN_ROOT}/agents/inbox-organiser.md` (resolve to a literal path before dispatch — see `agents-shared/vault-io.md` → Placeholders).

Spawn the `inbox-organiser` agent (dispatch: `skills-shared/dispatch.md`) with the full prompt from the agent definition, or launch a general-purpose agent that reads the agent file.

### Step 1.5: Surface Librarian Observations for Inbox Notes

While the inbox-organiser agent runs (this check is independent of its output), check the librarian queue for pending observations targeting inbox notes.

Read `PLUGIN_DATA/librarian/queue.jsonl` (where PLUGIN_DATA = `CLAUDE_PLUGIN_DATA` env; if absent, resolve via `node ${CLAUDE_PLUGIN_ROOT}/scripts/resolve-paths.mjs PLUGIN_DATA`; never hardcode a fallback path). Parse each line as JSON. Filter to items where `status === 'pending'`, `target` starts with `0-inbox/`, and `task` is one of: `voice_flag`, `tag_suggestion`, `duplicate_flag`.

If matches exist, include them as advisory context when presenting the agent's results, grouped by task type:

```
Librarian observations:
  Voice flags:
    "gmail multi daemon pull deduplication": Names a topic, not an insight. Consider retitling.
  Tag suggestions:
    "ginkgo biloba acute pk profile" → pharmacology, neuroscience
  Duplicate flags:
    "foo-claim.md" ↔ 3-permanent/foo-claim-original.md (similarity 0.93)
  ...
```

These are informational: the user decides whether to act on them during triage. Apply or dismiss them in `/health --librarian`.

### Step 2: Execute the Worklist and Gated Actions

The agent cannot spawn note-writer (subagents cannot spawn subagents). It returns a Rewrite Worklist; executing it is this skill's job.

**2a. Autonomous rewrites (no approval needed).** For each item with `type: rewrite`, spawn a `note-writer` agent (dispatch: `skills-shared/dispatch.md`) with:
- **insight**: the note's core idea
- **existing_note**: the full current note content (read it first)
- **destination**: the worklist destination
- **destination_locked**: `true` — the worklist destination already encodes the organiser's verify-note gate (a verify FAIL deliberately routed the note to `1-fleeting/`); the gate must NOT re-promote it to `3-permanent/` and defeat that verification gate
- **related_notes**: from the worklist row
- the worklist `reason` as rewrite context

Resolve all path placeholders in each prompt to literal absolute paths (see `agents-shared/vault-io.md` → Placeholders). Dispatch independent items concurrently (dispatch: `skills-shared/dispatch.md`). After note-writer reports the written file, `rm` the `0-inbox/` original and run the three post-promotion frontmatter hygiene checks from the agent's section 6a on the new file. If note-writer returned the note content instead of reporting a written path, Write the file yourself at the worklist destination before `rm`ing the original.

When the 2a fan-out completes, replay the PostToolUse hook chain on every written path — subagent Writes bypass it (see `skills-shared/hook-replay.md`, targeted variant):

```bash
printf '%s\n' "$WRITTEN_PATH_1" "$WRITTEN_PATH_2" \
  | node "${CLAUDE_PLUGIN_ROOT}/scripts/sweep-hook-replay.mjs" --stdin
```

Surface any `failures` from the JSON summary in Step 3.

**2b. Gated actions.** Present merges, deletes, inbox archival candidates (≤2-pass notes untouched ≥30 days, plus `status: resolved` notes untouched ≥30 days — agent Steps 1 and 4), and fleeting archival candidates (from the agent's Step 8 sweep) in one block; one user response handles all of them. On approval, execute in order:
1. deletes — `rm` each approved inbox copy
2. merges — for each approved `type: merge` item, spawn `note-writer` with BOTH notes' full content as input, the worklist destination, **`destination_locked: true`** (same rationale as 2a: the worklist destination already encodes the organiser's gate decisions, and the note-writer gate must not re-promote past them — user approval covered the merge, not a destination override), and instruction to write one merged note; after it reports the written file, `rm` both source notes, run the 6a hygiene checks, and replay the hook chain on the merged file (same snippet as 2a). If note-writer returned the merged note content instead of reporting a written path, Write the file yourself at the worklist destination before `rm`ing the two sources.
3. inbox archival — `mv` each approved candidate to `{{VAULT}}/_archive/0-inbox/` (create with `mkdir -p` if needed); the agent returns candidates only and never archives. This is the inbox ratchet exit: a weak note untouched for a month leaves triage instead of recirculating forever.
4. fleeting archival — `mv` each approved candidate to `{{VAULT}}/_archive/1-fleeting/` (create with `mkdir -p` if needed); the agent returns candidates only and never archives

If the agent returned a `fleeting repair` section (NEEDS-DEEPEN notes — gate-demoted notes with verification markers or `source: unverified`, untouched >14 days), surface it in Step 3 as a non-destructive `/deepen` suggestion. These are not gated and are never archived; just relay the recommendation. The agent caps the list at 5 (oldest first) with a `+N more` line when there are more — relay that line verbatim:

```
Fleeting notes needing repair (run /deepen to resolve):
- creatine-loading-halves-uptake-time — verification markers, 30 days old → /deepen "creatine-loading-halves-uptake-time"
+3 more — run /health to see the full list
```

**2c. Replay hooks over the agent's touched files.** The organiser's own `Edit` and `mv` calls (counter-argument link pairs, Zeigarnik status stamps, mv-promotions, 6a hygiene) also bypassed PostToolUse — 2a covers only note-writer output. After the gated actions complete, parse the `### Touched files` inventory from the agent's report (one vault path per line; skip if it says `none`) and replay the hook chain over it, same snippet as 2a:

```bash
printf '%s\n' "$TOUCHED_PATH_1" "$TOUCHED_PATH_2" \
  | node "${CLAUDE_PLUGIN_ROOT}/scripts/sweep-hook-replay.mjs" --stdin
```

Counter-argument link pairs matter most here — they are exactly what edge-infer should index. Resolve vault-relative paths to absolute before piping. Surface any `failures` from the JSON summary in Step 3.

### Step 3: Report and Limbo Relay

The agent returns a structured summary. Present it to the user, including the top-5 limbo list (Step 5.5 of the agent) verbatim.

The agent only presents that list — it cannot converse. Relay the user's per-note replies by executing the frontmatter edits the agent documented:

- **"close"** or **"close all"**: add `status: resolved` to the note's frontmatter via `Edit`
- **"plan"**: ask the user for a one-line intention, then write `intentions:` frontmatter as `- "<context>: <cue>"` and set `status: intentioned`
- **"skip"**: leave the note as-is

Limbo notes the skill edits here join the hook-replay scope: pipe them through the same 2c snippet if any were edited after 2c already ran.

## Key Principles

- **The skill is thin on judgment, not on execution.** Triage logic lives in the `inbox-organiser` agent and its `agents-shared/`; note-writer fan-out and gated-action execution live here, because subagents cannot spawn subagents.
- **Promotions are autonomous.** No approval needed.
- **Destructive actions are gated.** Merges, deletes, inbox archival, and fleeting archival need explicit user approval.
- **Closed notes leave triage.** A `status: resolved` note (closed in limbo triage) is skipped from gating/clustering, and once untouched ≥30 days the agent returns it as an inbox-archival candidate (gated, 2b) — it never recirculates through every run. This closes the inbox ratchet.
- **Counter-arguments get promoted, not suppressed.** Quality determines folder.
- **Fleeting sweep runs after inbox.** The agent returns archival candidates — promoted notes (2+ permanent refs) and stale project notes (0 refs, 60+ days old); this skill archives approved ones to `_archive/1-fleeting/`. It also returns NEEDS-DEEPEN notes (gate-demoted, untouched >14 days) as a non-destructive `/deepen` recommendation — closing the loop so marker-bearing fleeting notes get resurfaced for repair instead of accumulating forever.
