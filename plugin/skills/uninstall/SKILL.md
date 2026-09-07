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

   b. **Withdraw the links this machine issued**, one per machine listed, and
   do it while the hub is still reachable:

   ```bash
   ll-search link revoke <key_id> --config-dir <config_dir>
   ```

   It tells the hub first and drops the local row second. That order is not
   arbitrary: this store is this key's only record of what it issued, so
   dropping the row while the hub still serves the grant leaves nothing to
   sign a revocation *for*, and the other machine keeps full authority until
   the grant expires a year later.

   **Only the half this machine signed.** A link is two grants. The one the
   other machine issued to this one is that machine's statement about its own
   key, and only that machine can withdraw it — `link revoke` reports when one
   is still standing, and so should you. Saying "revoked" while half the door
   is open is worse than saying nothing.

   **What this still does not withdraw.** There is no way from here to
   withdraw a `follow` a peer holds on this vault; no command sends one. Those
   stay signed and valid at the hub until they lapse — **ninety days for a
   `follow`, a year for a `link`** — counted from the last sync that renewed
   them. If the operator wants one gone sooner, the key that signed it has to
   be told out of band.

   **And revoking deletes nothing from this disk.** A `link` is unscoped —
   "every vault this issuer owns" — so it names no single directory to remove.
   Step c is what actually clears the data, and it is not optional because
   step b ran.

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
including, explicitly, which grants are still live: any inbound link half
another machine must withdraw itself, and every `follow` a peer holds, which
nothing here can touch.
