# Post-Write Hook Replay

The PostToolUse dispatcher (`hooks/post-tool.js`, which runs the autolink, edge-infer, provenance, and reflect-track modules) does **not** fire on subagent Write/Edit tool calls. Notes written by subagents (`note-writer`, `literature-capturer`, `note-deepener`, etc.) bypass the structural backlink and typed-edge infrastructure entirely. Until Claude Code provides matcher support for subagent tool calls, skills must replay the hook chain explicitly.

`scripts/sweep-hook-replay.mjs` does this. It accepts vault paths via `--stdin` (newline-separated) or as positional args, replays the dispatcher per file (15s timeout each), and emits a JSON summary `{processed, ok, failed, failures}`. The modules are idempotent — safe to run on already-hooked notes.

## Canonical sweep (seed known paths + unlinked-body backfill)

This is the pattern used by `/ingest` Step 5.5, `/gaps` Step 4.5, and `/deepen` Step 1.5 — those steps call it "the unlinked-body sweep" (the historical name); execute this whole pattern, including the seeding step. (`/reflect` is not a consumer — it uses its own `reflect_sid`-keyed sweep, a different mechanism.)

**The unlinked-body walk alone cannot detect the notes this sweep exists to cover.** Writing subagents are contractually required to produce wikilink-filled bodies (`note-writer` templates `[[related-note]]` lines from `related_notes`; `note-deepener` requires at least one wiki-link), so their output never matches a "body has no `[[wikilinks]]`" condition. Relying on the walk alone silently excludes exactly those notes from edge inference. That is why step 1 below seeds the candidate list with every path you know a subagent wrote, unconditionally.

The pattern has two parts:

1. **Seed known paths.** Before running the block, collect every vault note path a subagent wrote or edited during this skill invocation: `note-writer` returns the filename it used, `note-deepener` reports the destination folder (and you passed it the note path), `literature-capturer` returns its filename. If the subagent does not report paths (e.g. `/ingest`'s routing agent), detect them — `git -C "$LL_VAULT" status --porcelain` (new/modified `.md` files) or `git diff --name-only` against the pre-dispatch state. These paths are replayed unconditionally; the modules are idempotent, so a false positive costs <1s.
2. **Unlinked-body backfill.** Walk the vault for markdown files whose bodies contain no `[[wikilinks]]` and append those. This catches stragglers from earlier sessions and notes written outside any reporting contract. Works regardless of git state.

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

# 1) Seed with known subagent-written paths (substitute the literal paths you
#    collected; keep just the truncate line if there are genuinely none).
: > "$SWEEP_CANDIDATES"
printf '%s\n' \
  "$LL_VAULT/0-inbox/<subagent-written-note>.md" \
  "$LL_VAULT/3-permanent/<deepened-note>.md" \
  >> "$SWEEP_CANDIDATES"

# 2) Backfill: append unlinked-body candidates (exclude 4-projects — free-form indexes)
LL_VAULT="$LL_VAULT" python3 - <<'PY' >> "$SWEEP_CANDIDATES"
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

# Dedupe (a seeded path can also match the backfill walk)
sort -u "$SWEEP_CANDIDATES" -o "$SWEEP_CANDIDATES"

if [ -s "$SWEEP_CANDIDATES" ]; then
  node "${CLAUDE_PLUGIN_ROOT}/scripts/sweep-hook-replay.mjs" --stdin < "$SWEEP_CANDIDATES"
fi
rm -f "$SWEEP_CANDIDATES"
```

Typical cost: <1s per file, usually 0–5 candidates per session. The `if [ -s ... ]` guard avoids spawning the script when there is nothing to replay.

## Targeted variant (known paths)

When a skill already knows which notes the subagent wrote (e.g., `note-writer` returned a filename), pipe those paths directly. Skips the walk and runs unconditionally.

```bash
printf '%s\n' "$NOTE_PATH_1" "$NOTE_PATH_2" \
  | node "${CLAUDE_PLUGIN_ROOT}/scripts/sweep-hook-replay.mjs" --stdin
```

Use this when the skill's only writes are the paths in hand and no backfill is wanted.

## When to use which

| Situation | Pattern |
|---|---|
| One subagent wrote one note, you have the path | targeted variant |
| Multiple subagents in sequence, paths known | targeted variant, collect paths into a file first |
| End of skill, may have written 0–N notes | canonical sweep (seed known paths, backfill the rest) |
| Backfill / batch repair across the vault | canonical sweep (empty seed is fine) |

Never rely on the unlinked-body walk to find subagent-written notes — their bodies contain wikilinks by contract, so the walk will not see them.

## Where to insert in a skill

Insert *after* the subagent returns. Collect the written paths from the subagent reports as they come back (or capture pre-dispatch git state when the subagent doesn't report paths) — the unlinked-body walk does NOT detect wikilinked subagent output on its own. The script is idempotent, so seeding a path that was already hooked is harmless. Report failures (the `failures` array in the JSON summary) in the skill's final report so users see hook errors.
