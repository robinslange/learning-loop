---
name: ingest
description: 'Pull external context into the second brain. Handles any format Claude can read: PDFs, images, code, conversations, docs, or raw text. Usage: /learning-loop:ingest linear ["project"], /learning-loop:ingest repo [path], /learning-loop:ingest context, /learning-loop:ingest (prompts for source).'
---

# Ingest — External Context Import

## Overview

Pulls data from external sources (Linear, repositories, or any content Claude can read), extracts atomic insights, previews them for confirmation, then routes to auto-memory and/or vault notes. The context mode accepts anything: PDFs, images, code files, conversation dumps, documents, or plain text.

## When to Use

- `/ingest linear` — pull my assigned Linear tickets
- `/ingest linear "Project Name"` — pull tickets from a specific project
- `/ingest linear --state "In Progress"` — filter by ticket state
- `/ingest repo ~/path/to/repo` — scan a repository
- `/ingest repo` — prompt for repo path
- `/ingest context` — provide any content (paste text, give a file path, drop an image)
- `/ingest` — ask which source type
- `--refine` — append to any source mode (e.g., `/ingest context --refine`) to enable Step 5.6 upstream refinement after ingest. Off by default; will move to default-on after a few validation runs.

## Process

### Step 0: Parameter Resolution

Parse the source type from the first argument.

**No argument (`/ingest`):**
Use `AskUserQuestion`:

> What would you like to ingest?
>
> - **linear** — Pull Linear tickets (my assigned, or a specific project)
> - **repo** — Scan a repository for architecture and patterns
> - **context** — Provide any content (text, PDF, image, code, doc) to extract insights from

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
- `AskUserQuestion`: "What would you like to ingest? You can paste text, provide a file path (PDF, image, code, doc), or describe what you'd like to import."
- If a file path is given, read it with the Read tool before passing to the agent.
- Announce: "Extracting insights..."

### Step 2: Launch Source Agent

Spawn the appropriate agent in the foreground:

**Linear:** Spawn a `general-purpose` agent with prompt:

```
Read the agent definition at PLUGIN/agents/ingest-linear.md and follow it exactly.

Scope: {scope}
State filter: {state_filter or "none"}
```

**Repo:** Spawn a `general-purpose` agent with prompt:

```
Read the agent definition at PLUGIN/agents/ingest-repo.md and follow it exactly.

Repo path: {repo_path}
```

**Context:** Spawn a `general-purpose` agent with prompt:

```
Read the agent definition at PLUGIN/agents/ingest-context.md and follow it exactly.

Source label: {source_label or "pasted text"}
Text:
{pasted_text}
```

### Step 3: Preview

Take the insights JSON returned by the agent.

Read `PLUGIN/agents/_skills/preview-format.md` and format the preview accordingly.

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
Read the agent skill at PLUGIN/agents/_skills/route-output.md and follow it exactly.

Project name: {project_name}
Vault path: {{VAULT}}/
Memory path: {memory_path}

Confirmed insights:
{confirmed_insights_json}
```

### Step 5.5: Post-Batch Sweep

The routing agent in Step 5 is a subagent. Its Write/Edit tool calls bypass PostToolUse hooks, so notes it creates miss `post-write-autolink.js` and `post-write-edge-infer.js` — ending up without suggested backlinks or typed edges.

Replay the hook chain on any vault notes missing structural backlinks. Idempotent — safe on already-hooked notes.

```bash
# Resolve plugin data dir, vault path, and ll-search binary at runtime.
PLUGIN_DATA="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/plugins/data/learning-loop-learning-loop-marketplace}"
LL_VAULT="$(node -e "const c=JSON.parse(require('fs').readFileSync(process.argv[1]+'/config.json','utf-8'));console.log(c.vault_path.replace(/^~/,require('os').homedir()))" "$PLUGIN_DATA")"
LL_BIN="$PLUGIN_DATA/bin/ll-search"
[ -x "$LL_BIN" ] || LL_BIN="${CLAUDE_PLUGIN_ROOT}/native/target/release/ll-search"

# Ensure new notes are indexed before the sweep + any downstream similarity queries.
ORT_DYLIB_PATH="$(dirname "$LL_BIN")" ORT_LIB_LOCATION="$(dirname "$LL_BIN")" \
  "$LL_BIN" index "$LL_VAULT" "$LL_VAULT/.vault-search/vault-index.db" 2>&1 | tail -1

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

Report any failures in Step 6. Typical cost: <1s per file, usually 0–5 candidates per batch (ingest typically produces few subagent-written notes that the routing step hasn't already linked via its prompt).

### Step 5.6: Upstream Refinement

**Behind a flag for the first ship.** Skip this step entirely unless the user invoked `/ingest` with `--refine` in the args. Default off because ingest batches can produce many candidates and we want cost visibility before promoting to default-on.

When the routing subagent in Step 5 writes new vault notes, those notes may sharpen, qualify, or extend existing claims. This step finds those pairs, dispatches the `refinement-proposer` agent, validates the output, and applies edits via `Write`. Same flow as `/reflect` Step 4.6.

#### 5.6.a — Detect new vault notes from this ingest

The routing subagent doesn't return file paths directly. Use `git diff` against HEAD to detect new files in the vault since ingest started:

```bash
cd "$HOME/brain"
git diff --name-only --diff-filter=A HEAD -- brain/0-inbox/ brain/1-fleeting/ brain/2-literature/ brain/3-permanent/ brain/5-maps/ \
  | sed "s|^|$HOME/brain/|" \
  > /tmp/ll-ingest-new-notes.txt
```

If the file is empty, skip the rest of 5.6 and report `Refinement: 0 new notes from ingest`.

**Caveat**: this assumes the vault was at clean HEAD state when ingest started. If the user had uncommitted vault work, it may include unrelated files. The hard cap on LLM calls (50, below) bounds the worst case.

#### 5.6.b — Build candidate pairs (capped)

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/refinement-candidates.mjs" --stdin --pairs-out /tmp/ll-refinement-pairs.json < /tmp/ll-ingest-new-notes.txt > /dev/null
```

If the resulting pairs JSON has more than **50** entries, truncate to the first 50 (highest cosine first since the candidate script sorts that way) and append the deferred remainder to `${CLAUDE_PLUGIN_DATA:-$HOME/.claude/plugins/data/learning-loop-learning-loop-marketplace}/refinement-deferred.jsonl` as one JSON object per line. The deferred queue is drained by the next `/reflect` invocation (which has no batch cap).

```bash
DATA_DIR="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/plugins/data/learning-loop-learning-loop-marketplace}"
mkdir -p "$DATA_DIR"
python3 - <<'PY'
import json
pairs = json.load(open("/tmp/ll-refinement-pairs.json"))
keep, defer = pairs[:50], pairs[50:]
json.dump(keep, open("/tmp/ll-refinement-pairs.json", "w"), indent=2)
import os
data_dir = os.environ.get("CLAUDE_PLUGIN_DATA", os.path.expanduser("~/.claude/plugins/data/learning-loop-learning-loop-marketplace"))
defer_path = os.path.join(data_dir, "refinement-deferred.jsonl")
if defer:
    with open(defer_path, "a") as f:
        for p in defer: f.write(json.dumps(p) + "\n")
    print(f"deferred {len(defer)} pairs to {defer_path}")
PY
```

#### 5.6.c — Dispatch, validate, present, apply

Same as `/reflect` Step 4.6.b through 4.6.f. Spawn `refinement-proposer` with the pairs file, validate via `refinement-validate.mjs`, present preview-format table, apply approved edits via `Write`, route counterpoints via `Edit`, emit provenance events.

The `subagent_type` is `learning-loop:refinement-proposer`. The `pairs_file` is `/tmp/ll-refinement-pairs.json`. Use `AskUserQuestion` for batch confirmation.

#### 5.6.d — Cleanup

```bash
rm -f /tmp/ll-ingest-new-notes.txt /tmp/ll-refinement-pairs.json /tmp/ll-refinement-agent-output.json /tmp/ll-refinement-validated.json
```

Report counts in Step 6.

### Step 6: Summary

Display the routing agent's summary, the sweep results, and the refinement results (if `--refine` was passed). Done.

## Key Principles

- **The skill is the UX layer.** Agents fetch and extract. The skill previews and routes.
- **Preview before write.** Never write to memory or vault without user confirmation.
- **Merge, don't overwrite.** Auto-memory files preserve manually-added context.
- **Vault notes go through note-writer.** Voice consistency matters.
- **One source per invocation.** To ingest from multiple sources, run the skill multiple times.
