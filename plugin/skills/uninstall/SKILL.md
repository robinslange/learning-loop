---
name: uninstall
description: Cleanly remove learning-loop and its footprint. Usage: /learning-loop:uninstall. Walks the three steps — marketplace removal, episodic-memory MCP removal, and purging captured indexes — with confirmation before each destructive action. Does not auto-delete.
disable-model-invocation: true
---

# Uninstall learning-loop

Removing the plugin via `/plugin` alone leaves two artefacts behind: the
`episodic-memory` MCP entry in `~/.claude.json` and the captured-index data
dir. This skill walks the full removal with operator confirmation.

## Steps

1. **Confirm intent.** Ask the operator to confirm they want to fully remove
   learning-loop, including all captured indexes (backlinks, justification
   index, session labels). If they only want hooks off, point them at
   `${CLAUDE_PLUGIN_ROOT}/README.md` — "Disabling parts without uninstalling"
   covers turning off individual hooks via `hooks.disabled` and every plugin's
   hooks via `disableAllHooks: true` — and stop.

2. **Remove the plugin.** Tell the operator to run `/plugin` and remove
   learning-loop via the marketplace UI. (Claude cannot drive the marketplace
   UI; the operator does this step.)

3. **Remove the dependent MCP** (confirm first):
   `claude mcp remove episodic-memory`
   Note: only if no OTHER installed plugin depends on episodic-memory. Check
   with `claude mcp list` and ask before removing.

4. **Purge captured indexes** (confirm first — irreversible):
   `rm -rf ~/.claude/plugins/data/learning-loop-learning-loop-marketplace/`
   Show the operator the dir's `du -sh` size before deleting so they see what
   is being purged.

Report what was removed and what (if anything) the operator chose to keep.
