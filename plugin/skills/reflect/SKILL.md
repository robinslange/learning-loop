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

**At session end:**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/provenance-emit.js" '{"agent":"reflect","skill":"reflect","action":"session-end","vault_notes":N,"auto_memories":N}'
```

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

| Category | Example | Destination | Confidence |
|---|---|---|---|
| **Correction received** | "Don't mock the DB in these tests" | Auto-memory (feedback) | strong |
| **Preference revealed** | "I prefer X approach over Y" | Auto-memory (user/feedback) | strong |
| **Decision made** | "We chose Postgres over SQLite because..." | Obsidian vault | - |
| **Problem solved** | "The build failed because X, fixed by Y" | Obsidian vault | - |
| **Pattern discovered** | "This pagination pattern works across projects" | Obsidian vault | - |
| **Domain insight** | "Resto Druid HoT uptime benchmarks are..." | Obsidian vault | - |
| **Project context** | "Auth rewrite is driven by compliance, not tech debt" | Auto-memory (project) | medium |
| **Cross-project connection** | "Same caching problem exists in Acme and Widget-Co" | Obsidian vault + links | - |
| **Implicit pattern** | User always runs tests before committing (observed 3+ times, never stated) | Auto-memory (feedback) | weak |

List each learning as a single line.

### Step 2.5: Batch Retrieval

Run a single retrieval call for all learnings identified in Step 2. Pass each learning summary as a query:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/vault-search.mjs reflect-scan "learning 1 summary" "learning 2 summary" ... --top 5
```

**MUST use the `vault-search.mjs` wrapper, not bare `ll-search reflect-scan`.** The wrapper prepends `DB_PATH` and `--config-dir` from plugin config; if you call the raw binary, always pass the db path explicitly — a missing DB arg silently corrupts results.

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
- **Keep memories tight at capture.** Target body sizes: feedback/user under 400 chars, project/reference under 800 chars. These targets sit below the dream COMPRESS thresholds (500 / 1,000): capturing tighter avoids round-trips through dream. Cut filler, keep the rule + Why + How to apply.
- Update MEMORY.md index

**For Obsidian vault items:**
- Write to `{{VAULT}}/0-inbox/` using the `Write` tool
- Follow capture-rules.md: one idea per note, title states the insight, body 3-10 lines, max 3 tags, at least one link
- Follow persona.md voice: Hemingway + Musashi + Lao Tzu. No filler.
- Tag with source project/domain
- Link to the project index note in `4-projects/` if one exists
- **Stamp `reflect_sid: <LL_SID>` in the frontmatter of every note you write this session** (where `LL_SID` is resolved as in the Step 4 init block below). The Step 4.4 sweep uses it to recover sub-agent notes (PostToolUse hooks don't fire on sub-agent writes); the Step 4.6.g cleanup strips it once tracking is done.
- **Create the session-keyed reflect new-notes marker once, at the start of Step 4.** From then until the Step 4.6.g cleanup, the post-tool hook (`hooks/modules/reflect-track.mjs`) appends every vault Write/Edit's absolute path to that file. Do not echo paths in by hand — the hook is the single writer. The marker lives in **plugin-data**, not tmp: resolve the session id via `node "${CLAUDE_PLUGIN_ROOT}/scripts/resolve-paths.mjs" SESSION_ID` and the marker dir via `resolve-paths.mjs REFLECT_SCRATCH` (as in the init block below), the same resolvers the hook uses, so writer and reader stay in lockstep.

```bash
# Step 4 init: truncate the new-notes file (the hook handshake marker).
# Run this ONCE, before any vault Writes in this step. Do not re-run per
# Write — the post-tool hook does the per-write appends automatically while
# this file exists. Step 4.6.g removes it to end the tracking window.
LL_SID=$(node "${CLAUDE_PLUGIN_ROOT}/scripts/resolve-paths.mjs" SESSION_ID)
LL_SCRATCH=$(node "${CLAUDE_PLUGIN_ROOT}/scripts/resolve-paths.mjs" REFLECT_SCRATCH)
mkdir -p "$LL_SCRATCH"
LL_TMP_PREFIX="${LL_SCRATCH}/ll-${LL_SID}-reflect"
: > "${LL_TMP_PREFIX}-new-notes.txt"
```

If a vault Write happens via a sub-agent (note-writer, discovery-researcher, literature-capturer), PostToolUse hooks don't fire on it directly, so its path never reaches the marker through the live hook. Step 4.4's sweep recovers those notes: it finds every note carrying this session's `reflect_sid`, then replays the hook chain via `sweep-hook-replay.mjs` with `LL_REFLECT_SID=$LL_SID` set. That env var flows into the replayed `reflect-track.mjs` as the explicit session override (see `hooks/post-tool.js`), so each replayed Write appends to *this* session's marker even when another `/reflect` is running concurrently. End result: every new note in this `/reflect` invocation lands in the file regardless of which thread wrote it.

### Step 4.4: Post-Batch Sweep

Subagent Write/Edit tool calls bypass PostToolUse hooks. Notes written earlier in this session by `note-writer`, `discovery-researcher`, `literature-capturer`, or any other subagent may have missed the `hooks/post-tool.js` dispatcher entirely (no suggested backlinks or typed edges), **and** never reached the reflect new-notes marker (so Step 4.6 refinement would skip them).

Replay the hook chain on two candidate sets, unioned: (1) notes missing structural backlinks (autolink/edge-infer backfill), and (2) every note carrying *this session's* `reflect_sid` (the marker backfill — these are the sub-agent notes whose paths the live hook never captured). The replay runs with `LL_REFLECT_SID=$LL_SID`, which routes each replayed Write to this session's marker even under concurrent `/reflect` runs. Idempotent: safe to run on already-hooked notes (autolink checks for existing links; reflect-track de-dups paths on read in Step 4.6.a).

```bash
# Resolve vault path from config. The ll-search shim (~/.local/bin/ll-search,
# installed by /init or the SessionStart hook) handles binary location and ORT
# env vars itself.
PLUGIN_DATA="${CLAUDE_PLUGIN_DATA:-$(node "${CLAUDE_PLUGIN_ROOT}/scripts/resolve-paths.mjs" PLUGIN_DATA)}"
LL_VAULT="$(node -e "const c=JSON.parse(require('fs').readFileSync(process.argv[1]+'/config.json','utf-8'));console.log(c.vault_path.replace(/^~/,require('os').homedir()))" "$PLUGIN_DATA")"

# Ensure new notes are indexed before the sweep + any downstream similarity queries.
# Incremental by default; only embeds notes that are new or mtime-changed.
ll-search index "$LL_VAULT" "$LL_VAULT/.vault-search/vault-index.db" 2>&1 | tail -1

LL_SID=$(node "${CLAUDE_PLUGIN_ROOT}/scripts/resolve-paths.mjs" SESSION_ID)
LL_SCRATCH=$(node "${CLAUDE_PLUGIN_ROOT}/scripts/resolve-paths.mjs" REFLECT_SCRATCH)
mkdir -p "$LL_SCRATCH"
SWEEP_CANDIDATES="${LL_SCRATCH}/ll-${LL_SID}-sweep-candidates.txt"

# Candidate union (exclude 4-projects: free-form indexes):
#   (1) notes with no [[links]] in the body  -> autolink/edge-infer backfill
#   (2) notes whose frontmatter reflect_sid == this session's LL_SID
#         -> marker backfill for sub-agent writes the live hook missed
# A note matching either set is emitted once (dedup via a set).
LL_VAULT="$LL_VAULT" LL_SID="$LL_SID" python3 - <<'PY' > "$SWEEP_CANDIDATES"
import os, re
root = os.environ["LL_VAULT"]
sid = os.environ["LL_SID"]
seen = set()
for d in ["0-inbox", "1-fleeting", "2-literature", "3-permanent", "5-maps"]:
    for dirpath, _, files in os.walk(os.path.join(root, d)):
        for f in files:
            if not f.endswith(".md"): continue
            p = os.path.join(dirpath, f)
            if p in seen: continue
            try:
                text = open(p).read()
            except Exception:
                continue
            m = re.match(r"^---\n(.*?)\n---\n", text, flags=re.DOTALL)
            fm = m.group(1) if m else ""
            body = text[m.end():] if m else text
            unlinked = not re.search(r"\[\[[^\]]+\]\]", body)
            mine = bool(sid) and re.search(
                r"^reflect_sid:\s*[\"']?" + re.escape(sid) + r"[\"']?\s*$", fm, flags=re.MULTILINE
            )
            if unlinked or mine:
                seen.add(p)
                print(p)
PY

if [ -s "$SWEEP_CANDIDATES" ]; then
  LL_REFLECT_SID="$LL_SID" node "${CLAUDE_PLUGIN_ROOT}/scripts/sweep-hook-replay.mjs" --stdin < "$SWEEP_CANDIDATES"
fi
rm -f "$SWEEP_CANDIDATES"
```

Expected output is a JSON summary `{processed, ok, failed, failures}`. Report failures in Step 5 if any. Typical cost: <1s per file, usually 0–5 candidates per session.

### Step 4.5: Intention Extraction

After writing new vault captures, scan each new note's body for intention patterns:
- "when working on X" / "when designing X" / "when building X"
- "use this for X" / "reference this for X"
- "apply to X" / "relevant to X"

If an intention pattern is found, extract to frontmatter:
```yaml
intentions:
  - "<extracted project/topic>: <the full intention sentence>"
status: intentioned
```

This ensures new notes with intentions appear in the next session's intention summary. Claude can drill into specific contexts on-demand.

### Step 4.6: Upstream Refinement

**Trigger**: the reflect new-notes file (`${LL_SCRATCH}/ll-${LL_SID}-reflect-new-notes.txt`, where `LL_SCRATCH` comes from `resolve-paths.mjs REFLECT_SCRATCH` and `LL_SID` from `resolve-paths.mjs SESSION_ID`) exists and is non-empty.

Read `${CLAUDE_PLUGIN_ROOT}/skills/reflect/steps/refinement.md` and execute it (sub-steps 4.6.a through 4.6.g: candidate pairs + deferred-queue drain, proposer dispatch, validation, confirmation, apply, provenance, cleanup).

Skip this entire step if the new-notes file does not exist or is empty (the session wrote no vault notes).

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
node "${CLAUDE_PLUGIN_ROOT}/scripts/marker.mjs" stamp last-reflect
```

Run this via the Bash tool at the end of every /reflect invocation. The marker lives in plugin-data (not tmp) so the Stop hook — which does not inherit this shell's `$TMPDIR` — reads the same file this command wrote. A non-zero exit here is non-fatal: surface the stderr message but do not re-run /reflect.

## Subagent Usage

None. All retrieval is handled by the `reflect-scan` binary command in the main thread.

## Key Principles

- **Not every session needs reflection.** Quick sessions get a quick "Nothing notable to capture."
- **Update over create.** Always check for existing notes/memories first.
- **Route correctly.** Behavioral stuff → auto-memory. Knowledge → vault. Don't mix them.
- **Voice matters.** Vault notes follow the persona. Short, sharp, linked.
- **Ask before restructuring.** Never promote, move, or edit notes outside `0-inbox/` without permission.
- **Cross-project transfer is the superpower.** The most valuable captures are patterns that apply beyond their origin project.
