# Post-Write Hook Replay

The PostToolUse dispatcher (`hooks/post-tool.js`, which runs the autolink, edge-infer, provenance, and reflect-track modules) does **not** fire on subagent Write/Edit tool calls. Notes written by subagents (`note-writer`, `literature-capturer`, `note-deepener`, etc.) bypass the structural backlink and typed-edge infrastructure entirely. Until Claude Code provides matcher support for subagent tool calls, skills must replay the hook chain explicitly.

`scripts/sweep-hook-replay.mjs` does this. It accepts vault paths via `--stdin` (newline-separated) or as positional args, replays the dispatcher per file (15s timeout each), and emits a JSON summary `{processed, ok, failed, failures}`. The modules are idempotent — safe to run on already-hooked notes.

## Canonical snippet (unlinked-body filter)

This is the pattern used by `/reflect` Step 4.4, `/ingest` Step 5.5, `/gaps` Step 4.5, and `/deepen` Step 1.5. It walks the vault, identifies markdown files whose bodies contain no `[[wikilinks]]`, and replays the hooks on those. Works regardless of git state.

```bash
# Resolve vault path from config. The ll-search shim (~/.local/bin/ll-search,
# installed by /init or the SessionStart hook) handles binary location and ORT
# env vars itself.
PLUGIN_DATA="${CLAUDE_PLUGIN_DATA:-$(node "${CLAUDE_PLUGIN_ROOT}/scripts/resolve-paths.mjs" PLUGIN_DATA)}"
LL_VAULT="$(node -e "const c=JSON.parse(require('fs').readFileSync(process.argv[1]+'/config.json','utf-8'));console.log(c.vault_path.replace(/^~/,require('os').homedir()))" "$PLUGIN_DATA")"

# Ensure new notes are indexed before the sweep + any downstream similarity queries.
ll-search index "$LL_VAULT" "$LL_VAULT/.vault-search/vault-index.db" 2>&1 | tail -1

# Session-keyed temp path so parallel skill invocations don't race.
SWEEP_CANDIDATES="${TMPDIR:-/tmp}/ll-${CLAUDE_CODE_SESSION_ID:-$$}-sweep-candidates.txt"

# Detect unlinked candidates (exclude 4-projects — free-form indexes)
LL_VAULT="$LL_VAULT" python3 - <<'PY' > "$SWEEP_CANDIDATES"
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

if [ -s "$SWEEP_CANDIDATES" ]; then
  node "${CLAUDE_PLUGIN_ROOT}/scripts/sweep-hook-replay.mjs" --stdin < "$SWEEP_CANDIDATES"
fi
rm -f "$SWEEP_CANDIDATES"
```

Typical cost: <1s per file, usually 0–5 candidates per session. The `if [ -s ... ]` guard avoids spawning the script when no unlinked notes exist.

## Targeted variant (known paths)

When a skill already knows which notes the subagent wrote (e.g., `note-writer` returned a filename), pipe those paths directly. Skips the walk and runs unconditionally.

```bash
printf '%s\n' "$NOTE_PATH_1" "$NOTE_PATH_2" \
  | node "${CLAUDE_PLUGIN_ROOT}/scripts/sweep-hook-replay.mjs" --stdin
```

Use this when the path list is small (≤ 5). For larger batches the unlinked-body filter is cheaper and self-correcting.

## When to use which

| Situation | Pattern |
|---|---|
| One subagent wrote one note, you have the path | targeted variant |
| Multiple subagents in sequence, paths known | targeted variant, collect paths into a file first |
| End of skill, may have written 0–N notes | unlinked-body filter (idempotent + self-detecting) |
| Backfill / batch repair | unlinked-body filter |

## Where to insert in a skill

Insert *after* the subagent returns. Capturing pre-state is unnecessary — the unlinked-body filter is self-detecting, and the script is idempotent. Report failures (the `failures` array in the JSON summary) in the skill's final report so users see hook errors.
