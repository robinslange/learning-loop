# Phase 6: Cache Health Statusline (optional)

Logs per-turn cache metrics (`cache_read_input_tokens`, `cache_creation_input_tokens`) from the Claude Code statusline payload to `PLUGIN_DATA/retrieval/cache-health-YYYY-MM.jsonl` and displays `cache NN%` in the statusline. Useful for detecting silent cache regressions and measuring the cost of context injection experiments. See `scripts/cache-health-report.mjs` for the summary tool.

## Dependencies

This feature currently targets oh-my-claude (https://github.com/npow/oh-my-claude) as the statusline runner. If oh-my-claude is not installed, skip this phase silently.

## 6a: Detect

If Phase 1's cache-health check reported `omc_installed: false`, skip Phase 6. Report once in the summary: "Cache health: oh-my-claude not installed, skipped."

If `omc_installed: true` and `configured: true`, the plugin is already set up. Skip with "Cache health: already installed."

If `omc_installed: true` and `configured: false`, proceed to 6b.

## 6b: Confirm

Ask:

> Install the cache-health statusline plugin? It logs per-turn cache metrics to `PLUGIN_DATA/retrieval/cache-health-YYYY-MM.jsonl` and shows cache hit rate in your statusline. Useful for spotting cache regressions.

On confirmation, run:

```bash
node PLUGIN/scripts/install-cache-health.mjs
```

The script is idempotent. It copies `PLUGIN/plugins/omc-cache-health/plugin.js` to `~/.claude/oh-my-claude/plugins/cache-health/`, then inserts `cache-health` into `~/.claude/oh-my-claude/config.json` under the first line's `left` column (after `context-percent` if present) and adds a default plugin config.

If the target directory is a symlink (development mode), the script leaves the file alone and only updates config.

## 6c: Verify

After install, re-run the detection step and confirm `configured: true`. Report: "Cache health: installed."
