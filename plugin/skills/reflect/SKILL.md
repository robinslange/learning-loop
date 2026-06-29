---
name: reflect
description: 'End-of-session consolidation. Usage: /learning-loop:reflect (no args). Reviews conversation, extracts learnings, routes to auto-memory or vault, cross-links projects, promotes inbox notes. Run after substantial work sessions.'
---

# Reflect: Learning Consolidation

## Overview

Structured checkpoint that extracts what was learned in this session and persists it to the right stores. This is how the learning loop closes: without this step, knowledge captured during the session rots.

## When to Use

- End of a substantial work session (any domain: code, research, theorycrafting, coaching, anything)
- When the Stop hook nudges you
- When the user explicitly asks to consolidate or reflect
- After receiving multiple corrections in a session

## Provenance

This skill emits provenance events for pipeline observability. Run each Bash command silently.

**At session start:**

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/provenance-emit.js" '{"agent":"reflect","skill":"reflect","action":"session-start"}'
```

The session-end emit runs in Step 6, coalesced with the completion marker stamp (one final Bash block instead of two).

The PostToolUse hook handles both provenance emission and the per-write tracking that Step 4.6 (Upstream Refinement) consumes. Step 4 only needs to create the new-notes marker once; the hook appends every vault Write/Edit to it until Step 4.6.g removes the marker.

## Process

Work through these steps in order. Be concise throughout: the vault voice is Hemingway, not Tolstoy.

### Step 1: Session Review

Silently review the conversation. Identify:

- **Domain**: What area of work/knowledge was this? (project name, topic area)
- **Nature**: Was this building, debugging, researching, deciding, learning, discussing?
- **Substance**: Rate the session: was it routine or did genuine learning happen?

If the session was purely routine (config change, typo fix, quick lookup), say so and skip to Step 5. Not every session produces learnings.

### Step 2: Extract Learnings

Identify what was learned. Categories:

| Category                     | Example                                                                    | Destination                 | Confidence |
| ---------------------------- | -------------------------------------------------------------------------- | --------------------------- | ---------- |
| **Correction received**      | "Don't mock the DB in these tests"                                         | Auto-memory (feedback)      | strong     |
| **Preference revealed**      | "I prefer X approach over Y"                                               | Auto-memory (user/feedback) | strong     |
| **Decision made**            | "We chose Postgres over SQLite because..."                                 | Obsidian vault              | -          |
| **Problem solved**           | "The build failed because X, fixed by Y"                                   | Obsidian vault              | -          |
| **Pattern discovered**       | "This pagination pattern works across projects"                            | Obsidian vault              | -          |
| **Domain insight**           | "Resto Druid HoT uptime benchmarks are..."                                 | Obsidian vault              | -          |
| **Project context**          | "Auth rewrite is driven by compliance, not tech debt"                      | Auto-memory (project)       | medium     |
| **Cross-project connection** | "Same caching problem exists in Acme and Widget-Co"                        | Obsidian vault + links      | -          |
| **Implicit pattern**         | User always runs tests before committing (observed 3+ times, never stated) | Auto-memory (feedback)      | weak       |

List each learning as a single line. When a learning could fit more than one row, the table's one-destination-per-row is the default, not a hard partition; apply the Route-correctly test (Key Principles) to decide.

Before finalizing, explicitly check the three categories that hide in a fast pass: corrections received mid-session, project-context shifts, and behavior repeated 3+ times but never stated. State present or absent for each. Do NOT invent a weak pattern to fill a slot; "absent" is valid and common.

### Step 2.5: Batch Retrieval

If any subagent (note-writer, discovery-researcher, literature-capturer) wrote vault notes _earlier in this session_, the search index may not cover them yet, so the dedup below would miss them. Refresh the index first (incremental; embeds only new or mtime-changed notes):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/vault-search.mjs" index
```

Skip this index refresh if no subagent wrote notes this session (a pure-conversation session). It is also re-run in Step 4.4 after this step's own writes; both passes are incremental and cheap.

Run a single retrieval call for all learnings identified in Step 2. Pass each learning summary as a query:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/vault-search.mjs reflect-scan "learning 1 summary" "learning 2 summary" ... --top 5
```

**MUST use the `vault-search.mjs` wrapper, not bare `ll-search reflect-scan`.** The wrapper prepends `DB_PATH` and `--config-dir` from plugin config; if you call the raw binary, always pass the db path explicitly — a missing DB arg silently corrupts results.

The Step 2.5 reflect-scan and the Step 2.75 episodic search are independent — you MAY issue both in the same turn. Only Step 2.5's output is required before Step 3.

Parse the JSON result. For each query:

- `top_match_similarity > 0.85`: likely duplicate. Read the existing note and update it instead of creating a new one.
- `top_match_similarity 0.74-0.85`: related note exists. Consider linking rather than duplicating.
- `top_match_similarity < 0.74`: no existing coverage. Create a new note.

This score is raw cosine between a short learning summary and a full note, so even a true duplicate rarely scores ~0.95; a 0.85 hit is already strong. (Both bands come from `scripts/lib/hook-config.mjs`: 0.85 is `SIMILARITY_THRESHOLD`, the bar the live duplicate gate uses; 0.74 is `COSINE_MIN`, the related-note band floor.)

Review `confusable_pairs` in the result. If any pairs are found, flag them for the user as potential MERGE or SHARPEN candidates in the Step 5 report.

### Step 2.75: Episodic Memory (optional)

If the episodic memory MCP tool is available (`mcp__plugin_episodic-memory_episodic-memory__search`), run one search for the session's primary topic/domain. Extract any relevant prior decisions or unresolved questions. If unavailable, skip silently.

### Step 3: Duplicate Check

Using the reflect-scan results from Step 2.5:

- For learnings with `top_match_similarity > 0.85`, read the matched note. If the existing note already captures the insight, skip creating a new one.
- For auto-memory items: grep the memory dir filenames and the MEMORY.md index lines for the learning's key terms. If 1-3 files match, read those in full and judge on their bodies. If a match states the same rule, edit it and bump its date rather than adding a second file. If grep returns nothing, write the new memory.

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
- **Keep memories tight at capture.** Target body sizes: feedback/user under 400 chars, project/reference under 800 chars. These targets sit below the dream COMPRESS thresholds (500 / 1,000): capturing tighter avoids round-trips through dream. Cut filler, keep the rule + Why + How to apply.
- Update MEMORY.md index

**For Obsidian vault items:**

- Write to `{{VAULT}}/0-inbox/` using the `Write` tool
- Follow capture-rules.md: one idea per note, title states the insight, body 3-10 lines, max 3 tags, at least one link
- Follow persona.md voice: Hemingway + Musashi + Lao Tzu. No filler.
- Tag with source project/domain
- Link to the project index note in `4-projects/` if one exists
- **Stamp `reflect_sid: <SESSION_ID>` in the frontmatter of every note you write this session** (where `SESSION_ID` is resolved as in the Step 4 init block below). The Step 4.4 sweep uses it to recover sub-agent notes (PostToolUse hooks don't fire on sub-agent writes); the Step 4.6.g cleanup strips it once tracking is done.
- **Create the session-keyed reflect new-notes marker once, at the start of Step 4.** From then until the Step 4.6.g cleanup, the post-tool hook (`hooks/modules/reflect-track.mjs`) appends every vault Write/Edit's absolute path to that file. Do not echo paths in by hand — the hook is the single writer. The marker lives in **plugin-data**, not tmp: resolve the session id and marker dir via `node "${CLAUDE_PLUGIN_ROOT}/scripts/resolve-paths.mjs" --sh` (exports `SESSION_ID` and `REFLECT_SCRATCH`, as in the init block below), the same resolvers the hook uses, so writer and reader stay in lockstep.

```bash
# Step 4 init: truncate the new-notes file (the hook handshake marker), after
# resolving the run-invariant paths ONCE via --sh.
#
# Run this ONCE, before any vault Writes in this step. Do not re-run per
# Write — the post-tool hook does the per-write appends automatically while
# this file exists. Step 4.6.g removes it to end the tracking window.
#
# One resolve-paths.mjs --sh call exports the values this step and 4.4/4.6/4.7
# use: SESSION_ID, REFLECT_SCRATCH (and PLUGIN_DATA/VAULT where a fence needs
# them). Because bash fences run in separate shells, each later fence re-runs
# this same --sh eval; within a fence the exported names are used directly (no
# aliasing). The marker dir/key MUST stay the values
# resolve-paths.mjs returns: the hook computes the same path independently via
# reflectScratchDir()+getSessionId(), so writer and reader stay in lockstep
# across the $TMPDIR-split hook/shell boundary. Never hardcode a tmp path or
# change the ll-${SESSION_ID}-reflect prefix shape.
eval "$(node "${CLAUDE_PLUGIN_ROOT}/scripts/resolve-paths.mjs" --sh)"
mkdir -p "$REFLECT_SCRATCH"
LL_TMP_PREFIX="${REFLECT_SCRATCH}/ll-${SESSION_ID}-reflect"
: > "${LL_TMP_PREFIX}-new-notes.txt"
```

Sub-agent writes (note-writer, discovery-researcher, literature-capturer) don't fire PostToolUse hooks, so their paths never reach the marker live; Step 4.4's sweep recovers them via the `reflect_sid` stamp (see that step for the mechanism).

### Step 4.4: Post-Batch Sweep

Subagent Write/Edit tool calls bypass PostToolUse hooks. Notes written earlier in this session by `note-writer`, `discovery-researcher`, `literature-capturer`, or any other subagent may have missed the `hooks/post-tool.js` dispatcher entirely (no suggested backlinks or typed edges), **and** never reached the reflect new-notes marker (so Step 4.6 refinement would skip them).

Replay the hook chain on two candidate sets, unioned: (1) notes missing structural backlinks (autolink/edge-infer backfill), and (2) every note carrying _this session's_ `reflect_sid` (the marker backfill — these are the sub-agent notes whose paths the live hook never captured). The replay runs with `LL_REFLECT_SID=$SESSION_ID`, which routes each replayed Write to this session's marker even under concurrent `/reflect` runs. Idempotent: safe to run on already-hooked notes (autolink checks for existing links; reflect-track de-dups paths on read in Step 4.6.a).

```bash
# This fence runs in its own shell, so re-resolve via --sh. The ll-search shim
# (~/.local/bin/ll-search, installed by /init or the SessionStart hook) handles
# binary location and ORT env vars itself.
eval "$(node "${CLAUDE_PLUGIN_ROOT}/scripts/resolve-paths.mjs" --sh)"

# Ensure new notes are indexed before the sweep + any downstream similarity queries.
# Incremental by default; only embeds notes that are new or mtime-changed.
ll-search index "$VAULT" "$VAULT/.vault-search/vault-index.db" 2>&1 | tail -1

# Candidate union, then replay, in one node pass (--scan-vault). The walk uses an
# explicit 5-folder ALLOWLIST that excludes 4-projects (free-form indexes), and
# emits each matching note once:
#   (1) notes with no [[links]] in the body  -> autolink/edge-infer backfill
#   (2) notes whose frontmatter reflect_sid == this session's SESSION_ID
#         -> marker backfill for sub-agent writes the live hook missed
# LL_REFLECT_SID=$SESSION_ID routes each replayed Write to THIS session's marker
# even under concurrent /reflect runs (see hooks/post-tool.js).
LL_REFLECT_SID="$SESSION_ID" node "${CLAUDE_PLUGIN_ROOT}/scripts/sweep-hook-replay.mjs" \
  --scan-vault "$VAULT" --sid "$SESSION_ID"
```

Expected output is a JSON summary `{processed, ok, failed, failures}` (and `{processed:0,...}` when no candidates). Report failures in Step 5 if any. Typical cost: <1s per file, usually 0–5 candidates per session.

### Step 4.5: Intention Extraction

After writing new vault captures, scan each new note's body for intention patterns:

- "when working on X" / "when designing X" / "when building X"
- "use this for X" / "reference this for X"
- "apply to X" / "relevant to X"

If an intention pattern is found, extract to frontmatter:

```yaml
intentions:
  - '<extracted project/topic>: <the full intention sentence>'
status: intentioned
```

This ensures new notes with intentions appear in the next session's intention summary. Claude can drill into specific contexts on-demand.

### Step 4.6: Upstream Refinement

**Trigger**: the reflect new-notes marker created in Step 4 (`${LL_TMP_PREFIX}-new-notes.txt`) exists and is non-empty. refinement.md 4.6.a re-resolves the prefix in its own shell.

Read `${CLAUDE_PLUGIN_ROOT}/skills/reflect/steps/refinement.md` and execute it (sub-steps 4.6.a through 4.6.g: candidate pairs + deferred-queue drain, proposer dispatch, validation, confirmation, apply, provenance, cleanup).

Skip this entire step if the new-notes file does not exist or is empty (the session wrote no vault notes).

### Step 4.7: Retrieval Usage Provenance

Read `${CLAUDE_PLUGIN_ROOT}/skills/reflect/steps/usage-provenance.md` and execute it: list the notes that injection/retrieval surfaced to this session (`retrieval-report.mjs --session-surfaced`), classify each as used (read, edited, or linked this session) or ignored, and emit one `note-usage` provenance event per note. Surfacing alone — including an injected note body — never counts as used; when unsure, classify as ignored.

Run this step even when Step 4.6 was skipped. Skip it only when nothing was surfaced to the session.

### Step 5: Report

Output a brief summary:

```
Reflected on [domain/project] session.
Captured: [N items] → [where they went]
Connections: [any cross-project links made]
Merge/Sharpen candidates: [any confusable_pairs flagged, or "none"]
Retrieval usage: [N used / M ignored of K surfaced — omit if nothing surfaced]
```

Keep it to 2-4 lines. The user can see the diffs if they want details.

### Step 6: Mark Reflection Complete

Emit the session-end provenance event and write the completion timestamp in one final block. Substitute the real counts for the `N`s (vault notes written, auto-memories written this session). Emit first, stamp last:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/provenance-emit.js" '{"agent":"reflect","skill":"reflect","action":"session-end","vault_notes":N,"auto_memories":N}'
node "${CLAUDE_PLUGIN_ROOT}/scripts/marker.mjs" stamp last-reflect
```

Run this at the end of **every** /reflect invocation, unconditionally — both lines always run, regardless of whether any notes were written or surfaced. The `last-reflect` marker is what tells the Stop hook reflection already happened; it lives in plugin-data (not tmp) so the Stop hook — which does not inherit this shell's `$TMPDIR` — reads the same file this command wrote. A non-zero exit on either line is non-fatal: surface the stderr message but do not re-run /reflect.

## Subagent Usage

| Agent               | Where                                                                 | Role                                                                    |
| ------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| refinement-proposer | Step 4.6.b (conditional: only when the session wrote new vault notes) | Classifies new-note → upstream-note pairs and proposes refinement edits |

Retrieval itself stays main-thread: it is handled by the `reflect-scan` binary command, not a subagent.

## Key Principles

- **Not every session needs reflection.** Quick sessions get a quick "Nothing notable to capture."
- **Update over create.** Always check for existing notes/memories first.
- **Route correctly.** Per learning: does it change how I should behave next session (rule, preference, correction, live project fact)? Route to auto-memory. Is it a durable claim about the world, true regardless of who acts? Route to the vault. When both fire (e.g. a decision with an ongoing behavioral implication), route the dominant facet and split only if each facet is separately useful to a different audience. Never write the same sentence to both stores; there is no cross-store dedup.
- **Voice matters.** Vault notes follow the persona. Short, sharp, linked.
- **Ask before restructuring.** Never promote, move, or edit notes outside `0-inbox/` without permission.
- **Cross-project transfer is the superpower.** The most valuable captures are patterns that apply beyond their origin project.
