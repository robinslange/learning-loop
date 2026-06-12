# Phase 1: Detect and Summarize

Run the health-check library, which is the single source of truth used by `/learning-loop:doctor` and the session-start detector:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/health-check.mjs --full --json
```

Parse the JSON. Each result has `id`, `name`, `status`, `severity`, `detail`, `fix`.

Also write the result as the shared cache for future session-start detector runs:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/health-check.mjs --full --json > <PLUGIN_DATA>/last-health.json
```

Now render the dashboard, mapping each check id to its dashboard row. Use these mappings:

| Dashboard row | Check id |
|---|---|
| Platform | (compute from `process.platform`, `process.arch` — not in library) |
| Vault | `vault-path` (path) + `vault-folders` (count) |
| Folders | `vault-folders` |
| System files | `vault-system-files` |
| Binary | `binary-exists` + `binary-runs` |
| Dependencies | `episodic-memory-installed` + `learning-loop-installed` |
| Search index | `search-index-exists` |
| Federation | (computed inline — see below) |
| Hub sync | (computed inline — see below) |
| CLAUDE.md | `claudemd-section-present` + `claudemd-section-current` |
| Librarian | (computed inline — see below) |
| Shims | `shims-exist` + `local-bin-on-path` |
| Model notes | (computed inline — see below) |

For rows marked "computed inline" below, the federation/hub-sync/librarian/model-notes detection is init-specific and remains in this phase. Do NOT add those to the health library — they're init-time decisions, not runtime health.

### Inline detection (init-specific only)

The following items stay inline in this phase (NOT delegated to the health library):

**Federation config:** Check `PLUGIN_DATA/federation/config.json` exists. If it does, read it and note: identity (displayName, pubkey), hub endpoint, local peer count, visibility rules.

**Seed location:** The federation seed normally lives in the binary's secure seed store (OS keyring or encrypted file), not as a plaintext file — no `.seed` on disk is the healthy state. Flag only if a plaintext `.seed` exists: in `${CLAUDE_PLUGIN_ROOT}/federation/` (very old installs — needs relocation, handled by the federation skill) or in `PLUGIN_DATA/federation/` (pre-v1.18 legacy — the federation skill offers `ll-search migrate-seed`).

**Federation connectivity:** If federation config exists and has a hub endpoint, run the ll-search binary: `ll-search sync <db_path> <vault_path>`. This exports the local index, connects to the hub, uploads, and downloads peer indexes. Report what actually happened, not what you think should happen.

**Cache health statusline:** Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/install-cache-health.mjs --check` and capture the JSON output. Note whether `omc_installed` is true and whether `configured` is true. This determines whether Phase 6 has anything to do.

**Librarian:** Check if `ollama` is installed (`which ollama`), system RAM (`sysctl -n hw.memsize` on macOS, `/proc/meminfo` on Linux), whether Gemma 4 E2B is pulled (`ollama list | grep gemma4:e2b`), and librarian config from `config.json` (`librarian.enabled`).

**Watch daemon status (init view):** If `ll-watch` shim exists, run `ll-watch status` to check if the watcher is running (this complements the library's `watch-daemon-status` check by surfacing the user-facing status output).

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
