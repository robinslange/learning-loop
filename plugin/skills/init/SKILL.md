---
name: init
description: "First-time setup or upgrade for the learning-loop plugin. Configures vault path, persona voice, CLAUDE.md integration, and verifies the installation. Hands federation off to /learning-loop:federation. Safe to re-run: detects existing state and skips completed steps."
disable-model-invocation: true
---

# Init: Learning Loop Setup

Eight-phase detect-confirm-apply flow. One question at a time. Safe to re-run: detects existing state and skips completed steps.

All operations use Node.js APIs (fs, path, child_process). No bash `find`, no shell globbing for detection.

## Paths

Resolve `PLUGIN_DATA`, `VAULT`, and the plugin root per `${CLAUDE_PLUGIN_ROOT}/skills-shared/paths-preamble.md` (read it and apply). Use those resolved values for ALL path references in the phase files.

## Process

Read each phase file in order and execute its instructions. After Phase 1's dashboard, only enter the phases the dashboard reports as needing work.

1. **Read `${CLAUDE_PLUGIN_ROOT}/skills/init/phases/01-detect.md`** -- detect state, present dashboard. If everything is configured, stop here.
2. **Read `${CLAUDE_PLUGIN_ROOT}/skills/init/phases/02-vault.md`** -- vault path, folders, system files.
3. **Read `${CLAUDE_PLUGIN_ROOT}/skills/init/phases/03-binary.md`** -- binary, vendor deps, orphan cleanup, index, shims, plugin deps.
4. **Read `${CLAUDE_PLUGIN_ROOT}/skills/init/phases/04-federation.md`** -- single yes/no, hands off to `/learning-loop:federation` for the full flow.
5. **Read `${CLAUDE_PLUGIN_ROOT}/skills/init/phases/05-claudemd.md`** -- instruction-file integration (CLAUDE.md, and AGENTS.md when Codex is present).
6. **Read `${CLAUDE_PLUGIN_ROOT}/skills/init/phases/06-cache-health.md`** -- optional cache-health statusline.
7. **Read `${CLAUDE_PLUGIN_ROOT}/skills/init/phases/07-librarian.md`** -- optional librarian background agent (incl. 7d: optional GLM Verify-offload provider for `/learning-loop:research`).
8. **Read `${CLAUDE_PLUGIN_ROOT}/skills/init/phases/08-seed-restore.md`** -- restore a seed bundle if present and seed the harvest deny-list.

After all phases complete, present the summary below.

## Summary

```
Learning loop configured.

  Vault:        [path] ([N] notes)
  Folders:      [N]/7 present
  Binary:       ll-search vX.Y
  Search:       [N] notes indexed
  Federation:   [configured | deferred to /learning-loop:federation | not requested]
  CLAUDE.md:    [status]
  AGENTS.md:    [status | skipped: codex not installed]
  Codex agents: [N generated in ~/.codex/agents | skipped: codex not installed]
  Cache health: [installed | skipped: oh-my-claude not found]
  Librarian:    [enabled | skipped: ollama/hardware not available]
  Seed restore: [restored from bundle | no bundle present]
  Harvest list: [seeded | empty (personal instance)]
  Shims:        ll-watch + ll-search installed in ~/.local/bin

Start the watcher with: ll-watch
Run /learning-loop:help to see available commands.
```

## Rules

- One question at a time. Wait for the answer before moving on.
- Validate paths before writing config.
- Never overwrite existing vault files without asking.
- Never restructure an existing vault.
- Preserve existing config.json fields when updating: read, merge, write.
- All detection via Node.js APIs. No `find`, no shell globbing.
- If any step fails, explain what went wrong and how to fix it.
- Works for: fresh install, existing vault + new plugin, or upgrade.
