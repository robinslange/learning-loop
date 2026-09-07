---
name: uninstall
description: Cleanly remove learning-loop and its footprint. Usage: /learning-loop:uninstall. Walks the steps — federation teardown, marketplace removal, episodic-memory MCP removal, and purging captured indexes — with confirmation before each destructive action. Does not auto-delete.
disable-model-invocation: true
---

# Uninstall learning-loop

Removing the plugin via `/plugin` alone leaves three artefacts behind: cached
copies of **other people's notes** under the federation data dir, the
`episodic-memory` MCP entry in `~/.claude.json`, and the captured-index data
dir. This skill walks the full removal with operator confirmation.

## Steps

1. **Confirm intent.** Ask the operator to confirm they want to fully remove
   learning-loop, including all captured indexes (backlinks, justification
   index, session labels). If they only want hooks off, point them at
   `${CLAUDE_PLUGIN_ROOT}/README.md` — "Disabling parts without uninstalling"
   covers turning off individual hooks via `hooks.disabled` and every plugin's
   hooks via `disableAllHooks: true` — and stop.

2. **Federation teardown** (only if `PLUGIN_DATA/federation/config.json` or
   `PLUGIN_DATA/vaults.json` exists). Do this **before** removing the plugin:
   `ll-search` lives under the plugin data dir, and after step 3 there is
   nothing left to run.

   **Tell the operator plainly what uninstalling does and does not do.**

   a. Show them what is live:

   ```bash
   ll-search link list --config-dir <config_dir>
   ```

   b. **Uninstalling does not withdraw anything.** There is no command that
   revokes a grant from this client — the wire message exists but nothing
   sends it. Every `link` grant naming this machine, and every `follow` a peer
   holds on this vault, stays signed and stays valid at the hub until it
   expires on its own: **a year for a `link`, ninety days for a `follow`.**
   Grants renew on use, so once this machine stops syncing they run down from
   whenever it last did.

   That is the honest state, and the operator should hear it before they
   delete the identity rather than after. If they want a grant gone sooner
   than its expiry, the person who signed it has to be told out of band.

   c. **Delete the cached peer indices** — this part is real, and nothing else
   will do it:

   ```bash
   du -sh <config_dir>/federation/data/peers/    # show them the size first
   rm -rf <config_dir>/federation/data/peers/
   ```

   These are **other people's notes**, held on this disk under grants that are
   ending. Removing the plugin without removing them leaves that content
   behind with nothing left that could ever check whether it is still allowed
   to be there. Repeat for every profile in `vaults.json`.

   Nothing is lost by deleting them: while the grants are still live a fresh
   `ll-search sync` refetches every index this key may read.

   d. **The seed is last, and warn first.** Deleting it destroys the identity.
   Without the 24-word recovery phrase there is no way back: every grant
   naming that key survives it, signed and permanently unreachable, and each
   linked machine has to be paired again from scratch. Ask whether the
   operator has the phrase written down before touching the seed, and if the
   backend is the OS keyring, say that step 4 will not reach it — the keyring
   entry has to be removed by hand.

3. **Remove the plugin.** Tell the operator to run `/plugin` and remove
   learning-loop via the marketplace UI. (Claude cannot drive the marketplace
   UI; the operator does this step.)

4. **Remove the dependent MCP** (confirm first):
   `claude mcp remove episodic-memory`
   Note: only if no OTHER installed plugin depends on episodic-memory. Check
   with `claude mcp list` and ask before removing.

5. **Purge captured indexes** (confirm first — irreversible):
   `rm -rf ~/.claude/plugins/data/learning-loop-learning-loop-marketplace/`
   Show the operator the dir's `du -sh` size before deleting so they see what
   is being purged.

Report what was removed and what (if anything) the operator chose to keep —
including, explicitly, the grants that are still live because nothing here
could withdraw them.
