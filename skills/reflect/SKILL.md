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
node "${CLAUDE_PLUGIN_ROOT}/scripts/provenance-emit.js" '{"agent":"reflect","skill":"reflect","action":"session-start"}'
```

**At session end:**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/provenance-emit.js" '{"agent":"reflect","skill":"reflect","action":"session-end","vault_notes":N,"auto_memories":N}'
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
node PLUGIN/scripts/vault-search.mjs reflect-scan "learning 1 summary" "learning 2 summary" ... --top 5
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
- **After each vault note Write, append its absolute path to `/tmp/ll-reflect-new-notes.txt`** (one per line). Step 4.6 (Upstream Refinement) reads this file. If you write zero vault notes in this step, leave the file empty or absent.

```bash
# Initialize at the start of Step 4 (truncates any stale file from a prior reflect):
: > /tmp/ll-reflect-new-notes.txt
# After each vault Write:
echo "<absolute-path-to-just-written-note>" >> /tmp/ll-reflect-new-notes.txt
```

### Step 4.4: Post-Batch Sweep

Subagent Write/Edit tool calls bypass PostToolUse hooks. Notes written earlier in this session by `note-writer`, `discovery-researcher`, `literature-capturer`, or any other subagent may have missed `post-write-autolink.js` and `post-write-edge-infer.js` entirely — ending up without suggested backlinks or typed edges.

Replay the hook chain on any vault notes missing structural backlinks. Idempotent — safe to run on already-hooked notes.

```bash
# Resolve plugin data dir, vault path, and ll-search binary at runtime.
PLUGIN_DATA="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/plugins/data/learning-loop-learning-loop-marketplace}"
LL_VAULT="$(node -e "const c=JSON.parse(require('fs').readFileSync(process.argv[1]+'/config.json','utf-8'));console.log(c.vault_path.replace(/^~/,require('os').homedir()))" "$PLUGIN_DATA")"
LL_BIN="$PLUGIN_DATA/bin/ll-search"
[ -x "$LL_BIN" ] || LL_BIN="${CLAUDE_PLUGIN_ROOT}/native/target/release/ll-search"

# Ensure new notes are indexed before the sweep + any downstream similarity queries.
# Incremental by default; only embeds notes that are new or mtime-changed.
ORT_DYLIB_PATH="$(dirname "$LL_BIN")" ORT_LIB_LOCATION="$(dirname "$LL_BIN")" \
  "$LL_BIN" index "$LL_VAULT" "$LL_VAULT/.vault-search/vault-index.db" 2>&1 | tail -1

# Detect unlinked candidates (exclude 4-projects — free-form indexes)
LL_VAULT="$LL_VAULT" python3 - <<'PY' > /tmp/ll-sweep-candidates.txt
import os, re
root = os.environ["LL_VAULT"]
for d in ["0-inbox", "1-fleeting", "2-literature", "3-permanent", "5-maps"]:
    for dirpath, _, files in os.walk(os.path.join(root, d)):
        for f in files:
            if not f.endswith(".md"): continue
            p = os.path.join(dirpath, f)
            try:
                body = open(p).read()
                body = re.sub(r"^---\n.*?\n---\n", "", body, count=1, flags=re.DOTALL)
                if not re.search(r"\[\[[^\]]+\]\]", body):
                    print(p)
            except: pass
PY

if [ -s /tmp/ll-sweep-candidates.txt ]; then
  node "${CLAUDE_PLUGIN_ROOT}/scripts/sweep-hook-replay.mjs" --stdin < /tmp/ll-sweep-candidates.txt
fi
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
  - "<extracted project/topic> — <the full intention sentence>"
status: intentioned
```

This ensures new notes with intentions appear in the next session's intention summary. Claude can drill into specific contexts on-demand.

### Step 4.6: Upstream Refinement

When a new vault note touches a claim already in the vault, the existing claim should be refined to incorporate the new evidence. This step finds those pairs, asks the `refinement-proposer` agent to draft edits, validates them, presents the batch for confirmation, and applies via `Write`. Contradictions route to inline counter-argument linking instead of editing the upstream body.

Skip this entire step if `/tmp/ll-reflect-new-notes.txt` does not exist or is empty (the session wrote no vault notes).

#### 4.6.a — Build candidate pairs

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/refinement-candidates.mjs" --stdin --pairs-out /tmp/ll-refinement-pairs.json < /tmp/ll-reflect-new-notes.txt > /dev/null
```

If the resulting `/tmp/ll-refinement-pairs.json` is `[]`, report `Refinement: 0 candidates in band` in Step 5 and skip the rest of 4.6.

#### 4.6.b — Dispatch refinement-proposer agent

Spawn the refinement-proposer agent with `subagent_type: "learning-loop:refinement-proposer"` and the prompt:

```
Read the agent definition at PLUGIN/agents/refinement-proposer.md and follow it exactly.

pairs_file: /tmp/ll-refinement-pairs.json
vault_path: {{VAULT}}/

Return the JSON response only, no commentary, no markdown fences.
```

Capture the agent's stdout response. Write it to `/tmp/ll-refinement-agent-output.json`.

#### 4.6.c — Validate

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/refinement-validate.mjs" /tmp/ll-refinement-agent-output.json /tmp/ll-refinement-pairs.json > /tmp/ll-refinement-validated.json
```

The validator strips em-dashes, computes sentence delta, and tags each decision with status `ok`, `oversized_warning`, or `auto_rejected`. The cleaned proposed bodies replace the agent's originals.

#### 4.6.d — Present batch for confirmation

Read `/tmp/ll-refinement-validated.json`. Build a preview-format table from the `decisions` array:

```markdown
## Refinement Proposals (N total)

### Edits ({edit_ok} ok, {edit_oversized} oversized warnings, {edit_auto_rejected} auto-rejected)

| # | upstream | type | Δ% | summary |
|---|----------|------|----|---------|
| 1 | websocket-has-no-built-in-reconnection | extends | 12% | Added Vercel/CF/AWS proxy timeout numbers |
| 2 | (warn) digital-signatures-prove-authorship | qualifies | 28% | Added challenge-response gap discussion |

### Counterpoints ({counterpoint_ok})

| # | upstream | reason |
|---|----------|--------|
| 3 | concept-creep-and-diagnostic-bracket-creep | new note disputes the bracket-vs-vertical distinction |

### Auto-rejected ({edit_auto_rejected})

| # | upstream | Δ% | reason |
|---|----------|----|--------|
| 4 | ... | 73% | exceeded 50% body change ceiling |

**Actions**: type `apply all` to apply every ok + oversized item, `apply ok` to apply only `ok` items, `apply N M` for specific IDs, `diff N` to print the unified diff for one item, or `none` to cancel.
```

Use `AskUserQuestion` for the action selection.

If the user types `diff N`, print the unified diff between the upstream's current body and the validated `proposed_body` for decision N, then re-prompt.

#### 4.6.e — Apply approved edits

For each decision in the approved set:

- **edit**: write the validated `proposed_body` to `upstream_path` using the `Write` tool. The post-write hook chain re-fires (autolink, edge-infer, provenance).
- **counterpoint**: append `new_note_link_text` to the new note's body via `Edit`, and append `upstream_link_text` to the upstream's body via `Edit`. Do NOT modify the upstream's claim. Both edits should append to the body, not modify existing lines. Skip if a link with the same target already exists in either file.
- **auto_rejected**: never apply. Log only.
- **pass**: never apply. Log only.

#### 4.6.f — Emit provenance

For each applied refinement:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/provenance-emit.js" '{"agent":"refinement-proposer","skill":"reflect","action":"refinement-applied","target":"<upstream-path>","new_note":"<new-note-path>","subtype":"<edit_subtype>","cosine":<cosine>}'
```

For counterpoints emit `action: "counterpoint-linked"`. For auto-rejected emit `action: "refinement-rejected"` with `reason: "oversized"`.

#### 4.6.g — Cleanup

```bash
rm -f /tmp/ll-reflect-new-notes.txt /tmp/ll-refinement-pairs.json /tmp/ll-refinement-agent-output.json /tmp/ll-refinement-validated.json
```

Report counts in Step 5: `Refinement: N edits applied, M counterpoints linked, K passed, J auto-rejected`.

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
node -e "require('fs').writeFileSync(require('path').join(require('os').tmpdir(), 'learning-loop-last-reflect'), Math.floor(Date.now()/1000).toString())"
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
