---
name: deepen
description: 'Strengthen a single vault note with research. Usage: /learning-loop:deepen "note name" or /learning-loop:deepen (picks shallowest inbox note). Assesses maturity, researches gaps, rewrites in vault voice, promotes when ready.'
---

# Deepen — Research and Enrichment

## Overview

Launches the `note-deepener` agent to strengthen a single note. The agent assesses maturity, researches gaps scaled to need, rewrites in persona voice, verifies sources, and promotes when ready. Shallow notes get heavy research; deep notes get a light touch.

## When to Use

- `/deepen <note-name>` — target a specific note
- `/deepen` — no argument; picks the shallowest inbox note
- When `/inbox` flags a note as needing deepening
- When a note feels thin and the user wants to strengthen it

## Provenance

This skill emits provenance events for pipeline observability. Run each Bash command silently.

**At session start:**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/provenance-emit.js" '{"agent":"deepen","skill":"deepen","action":"session-start","target":"NOTE_FILENAME"}'
```

**At session end:**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/provenance-emit.js" '{"agent":"deepen","skill":"deepen","action":"session-end","target":"NOTE_FILENAME","promoted":true|false}'
```

Per-note tracking is handled automatically by the PostToolUse hook.

## Process

### Step 0: Parameter Resolution

**No argument (`/deepen`):**
Use `AskUserQuestion`:

> Which note would you like to deepen?
>
> - **Type a note name** — I'll find and strengthen it
> - **Leave blank** — I'll pick the shallowest inbox note automatically

**Argument provided:**
Proceed immediately.

### Step 1: Launch Agent

Launch the `note-deepener` agent with:
- **note_path**: Path to the target note (resolve via `Glob` if only a name was given)
- **vault_path**: `{{VAULT}}/`

The agent definition is at `PLUGIN/agents/note-deepener.md`.

If no note name was provided, pass no note_path — the agent will pick the shallowest inbox note.

### Step 1.5: Replay Post-Write Hooks

The `note-deepener` is a subagent. Its Write/Edit tool calls bypass PostToolUse, so the deepened note (and any split note in `0-inbox/`) miss `post-write-autolink.js` and `post-write-edge-infer.js`.

Run the unlinked-body sweep from `skills/_shared/hook-replay.md` to catch them. Idempotent — safe on already-hooked notes:

```bash
PLUGIN_DATA="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/plugins/data/learning-loop-learning-loop-marketplace}"
LL_VAULT="$(node -e "const c=JSON.parse(require('fs').readFileSync(process.argv[1]+'/config.json','utf-8'));console.log(c.vault_path.replace(/^~/,require('os').homedir()))" "$PLUGIN_DATA")"

ll-search index "$LL_VAULT" "$LL_VAULT/.vault-search/vault-index.db" 2>&1 | tail -1

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

Report failures in Step 2 if any.

### Step 2: Present Results

The agent returns a structured report with before/after comparison, maturity transition, and destination. Present it to the user.

If the agent flagged uncaptured sources, suggest `/literature` for each.

## Resolving Verification Markers

If the note contains write-time verification markers, prioritize resolving them:

- `[unresolved]` -- search for the source via web search. If found, add the URL/DOI and remove the marker. If genuinely unfindable, either find an alternative source for the claim or remove the claim.
- `[unverified]` -- run `node PLUGIN/scripts/source-resolver.mjs verify-note <path>` to see the specific issue. Fix the author/year, then remove the marker.
- `[not in abstract]` -- fetch the full source (web fetch the URL or DOI page). If the number appears in the full text, remove the marker. If it doesn't, either correct the number or add scope qualification.

## Key Principles

- **The skill is thin.** All logic lives in the `note-deepener` agent and its `_skills/`.
- **Scale effort to need.** The agent handles this automatically via promote-gate assessment.
- **Promotions are autonomous.** The agent promotes based on quality — no approval needed.
- **Splits go to inbox.** If the agent found two ideas, the second lands in `0-inbox/`.
