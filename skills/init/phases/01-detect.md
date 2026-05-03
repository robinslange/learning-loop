# Phase 1: Detect and Summarize

Run all checks silently before asking anything. Use Node.js APIs throughout.

1. **Platform:** `process.platform`, `process.arch`
2. **Config:** Read `PLUGIN_DATA/config.json` (fallback `PLUGIN/config.json`)
3. **Vault:** Read `vault_path` from config, verify directory exists via `fs.existsSync`, count `.md` files with `fs.readdirSync` (recursive)
4. **Folders:** Check for `0-inbox`, `1-fleeting`, `2-literature`, `3-permanent`, `4-projects`, `5-maps`, `_system`
5. **System files:** Check `_system/persona.md` and `_system/capture-rules.md` exist
6. **Binary:** Check `PLUGIN_DATA/bin/ll-search` exists; if so, run `ll-search version`
7. **Dependencies:** Run `node PLUGIN/scripts/check-deps.mjs`
8. **Search index:** If binary present, run `ll-search status`
9. **Federation config:** Check `PLUGIN_DATA/federation/config.json` exists. If it does, read it and note: identity (displayName, pubkey), hub endpoint, local peer count, visibility rules.
10. **Seed location:** Check if `.seed` exists in `PLUGIN/federation/` (legacy, needs migration) vs `PLUGIN_DATA/federation/` (correct). Flag if legacy seed found.
11. **Federation connectivity:** If federation config exists and has a hub endpoint, run the ll-search binary: `ll-search sync <db_path> <vault_path>`. This exports the local index, connects to the hub, uploads, and downloads peer indexes. Report what actually happened, not what you think should happen.
12. **CLAUDE.md:** Check if `~/.claude/CLAUDE.md` exists. If it does, check whether it contains a `## Learning Loop` section (search for `<!-- learning-loop v` version comment). Read the template version from `PLUGIN/templates/claudemd-section.version` (a single-line file containing the template version, e.g. `1`). Compare against the version in the user's comment tag. Note: present/missing/outdated (version mismatch).
13. **Cache health statusline:** Run `node PLUGIN/scripts/install-cache-health.mjs --check` and capture the JSON output. Note whether `omc_installed` is true and whether `configured` is true. This determines whether Phase 6 has anything to do.
14. **Librarian:** Check if `ollama` is installed (`which ollama`), system RAM (`sysctl -n hw.memsize` on macOS, `/proc/meminfo` on Linux), whether Gemma 4 E2B is pulled (`ollama list | grep gemma4:e2b`), and librarian config from `config.json` (`librarian.enabled`).
15. **CLI shims:** Run `node PLUGIN/scripts/install-shims.mjs --check` to see whether `~/.local/bin/ll-watch` and `~/.local/bin/ll-search` exist. If `ll-watch` exists, run `ll-watch status` to check if the watcher is running.

Present a dashboard:

```
Learning Loop Setup

  Platform:      macOS (darwin arm64)
  Vault:         /path/to/vault (2,031 notes)
  Folders:       7/7 present
  System files:  persona + capture rules
  Binary:        ll-search v1.4.0 (installed)
  Dependencies:  all satisfied
  Search index:  2,031 notes indexed
  Federation:    configured (peer registered, hub connected)
  Hub sync:      working (1,200 notes exported, 1 peer downloaded)
  CLAUDE.md:     ~/.claude/CLAUDE.md (learning-loop section present)
  Librarian:     [status]
  Shims:         ll-watch installed, ll-search installed (watcher not running)

Everything looks good. Nothing to set up.
```

**Librarian status values:**

- `enabled (ollama running, gemma4:e2b loaded)`: librarian is enabled and working
- `available (ollama installed, XGB RAM)`: hardware capable but not enabled
- `skipped (requires ollama + 16GB+ RAM)`: hardware insufficient
- `skipped (ollama not installed)`: ollama missing

**Federation status rules:**

- Only report what the connectivity test actually returned. Never infer or guess peer registration status.
- If sync succeeded: report note counts and peers downloaded.
- If sync failed with auth error: report "auth failed: your pubkey may not be registered on the hub."
- If sync failed with connection error: report "hub unreachable: check Tailscale and hub endpoint."
- If no federation config: report "not configured."
- Never tell the user that a remote peer "needs to register" you unless the hub explicitly rejected auth with that reason.

If everything is configured, stop the entire init flow here. If issues exist, proceed to the relevant phases only.

**Model advisory (Opus 4.7+):**
If the orchestrator model is Opus 4.7 or later, append to the dashboard:

```
  Model notes:   Opus 4.7 detected. Research agents use effort: xhigh.
                 Dispatch instructions are explicit for literal instruction-following.
                 Cost tip: set CLAUDE_CODE_SUBAGENT_MODEL=claude-sonnet-4-6
                 to route subagents to Sonnet while keeping Opus as orchestrator.
```

This is informational only. No configuration is needed: the agent frontmatter and skill content are forward-compatible with both 4.6 and 4.7.
