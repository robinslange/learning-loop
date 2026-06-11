---
name: seed
description: "Build a portable starter slice from this learning-loop instance for a fresh instance to boot from. Usage: /learning-loop:seed [--for-job] [--types feedback,reference] [--out <dir>]. Default --for-job carries working-style (feedback memories + _system + portable prefs), no vault notes, no projects. Use when ramping up at a new job, a new project vault, or a second machine."
---

# Seed a fresh instance

Produces a `seed-bundle-<date>/` an empty learning-loop instance can boot from via `/learning-loop:init`. Carries your working-style, not your knowledge or projects.

## Paths

`PLUGIN_DATA` and `VAULT` are injected by the session-start hook; the plugin root is `${CLAUDE_PLUGIN_ROOT}` (a real env var in Bash blocks, injected as the `PLUGIN=` context line). If absent, resolve via `node ${CLAUDE_PLUGIN_ROOT}/scripts/resolve-paths.mjs`. Resolve the auto-memory dir mechanically (do NOT hand-construct the slug):
```
node -e "import('${CLAUDE_PLUGIN_ROOT}/scripts/lib/memory-paths.mjs').then(m=>console.log(m.resolveMemoryDir(process.env.CLAUDE_PROJECT_DIR)))"
```

## Process

### 1. Resolve inputs
- Default preset `--for-job`: `types = ["feedback"]`, no vault tiers.
- `--types a,b` overrides the type set. `--tiers <tier>` (e.g. `3-permanent`) opts in vault notes and triggers a hard scrub (see step 4).
- Default name deny-list for the scrub: project-flavored feedback. Build it mechanically — do NOT hand-curate. Pass the patterns the operator confirms; start from obvious client/product/person tokens visible in filenames.

### 2. Mechanical selection
Run:
```
node ${CLAUDE_PLUGIN_ROOT}/scripts/seed-select.mjs <memDir> <types-csv> <deny-csv>
```
This returns `{kept, dropped}`. The `type` filter and name deny-list are mechanical. Do not add files the script dropped.

### 3. Present for consolidation (the home-brain benefit)
Show the operator the `kept` list and the `dropped` list with reasons. Ask: any kept file that is actually project-specific or personal and should be dropped? Any dropped file that is genuinely portable and should be kept? This is the consolidation moment — encourage pruning stale feedback at the source.

### 4. Scrub (only if --tiers used)
If vault tiers were opted in, run the candidate notes through the same scrubber harvest uses (pass PLUGIN_DATA so instance facts merge in):
```
node ${CLAUDE_PLUGIN_ROOT}/scripts/harvest-scrub.mjs "<denylistFile>" "<PLUGIN_DATA>" <note-path...>
```
Block anything the scrub blocks. (Reuses the harvest scrubber — same mechanical gate.) A vault tier can hold hundreds of notes; if the path list is large, pipe paths on stdin instead of argv: `... harvest-scrub.mjs "<denylistFile>" "<PLUGIN_DATA>" < notes.txt`. For `--for-job` (no tiers) this step is skipped entirely.

### 5. Assemble the bundle
Create `<out>/seed-bundle-<date>/` (default `<out>` = cwd):
- `memory/` — copy each kept memory file verbatim.
- `_system/` — copy `persona.md`, `capture-rules.md`, `learning-loop-protocol.md` from VAULT/_system. Do NOT copy `nli-conflicts.md` (large, instance-specific).
- `CLAUDE-portable.md` — extract the portable sections of the operator's global `~/.claude/CLAUDE.md` (the learning-loop, code-style, git sections). Ask the operator to confirm the slice before writing — global CLAUDE.md may contain machine/personal specifics.
- `SEED-MANIFEST.md` — list contents, every dropped file + reason, and boot instructions: "Clone learning-loop at the target instance, run /learning-loop:init, and point it at this bundle when prompted."

Do NOT write any index file. The receiving instance rebuilds `MEMORY.md` from scratch.

### 6. Report
Tell the operator the bundle path and the kept/dropped counts.
