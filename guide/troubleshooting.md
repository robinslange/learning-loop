# Troubleshooting

Run `/learning-loop:doctor` first — it diagnoses and offers fixes for most of the issues below.

Commands below written as `node PLUGIN/scripts/...` use `PLUGIN` as shorthand for your installed plugin directory: `~/.claude/plugins/cache/learning-loop-marketplace/learning-loop/<version>` (or your repo checkout if you develop locally).

## `/learning-loop:init` hangs on binary download

The `ll-search` binary is ~60MB (includes embedding and reranker models). On slow connections, the download can take a minute. If it fails, re-run init.

## Search returns no results

Run `node PLUGIN/scripts/vault-search.mjs index --force` to rebuild the index. The index lives in `<vault>/.vault-search/` and survives plugin reinstalls. Under normal operation the index stays current via the `ll-search watch` daemon spawned at SessionStart — check that the daemon is alive with `ll-watch status`. If it reports not running, start a new session or run `ll-watch` (no arguments).

## Shadow injection log shows 0 passes

First check that the backends are alive. Open a recent shadow record and look at `backends.vault.error` and `backends.episodic.error`.

- If you see `spawn ... ENOENT`, run `/learning-loop:init` to install the binary.
- If `episodic-memory` exits with a NODE_MODULE_VERSION mismatch, rebuild with `npm rebuild --prefix ~/.claude/plugins/cache/superpowers-marketplace/episodic-memory/<version>`.
- If both backends are healthy but the gate never passes, the threshold is too high. Lower `injection_threshold` in `config.json` (or set `LEARNING_LOOP_INJECTION_THRESHOLD`).

## Notes not showing up in vault

Check that `config.json` in `PLUGIN_DATA` (set by `CLAUDE_PLUGIN_DATA` env var) has the correct `vault_path`. If set, the `VAULT_PATH` environment variable overrides it.

## Librarian not starting

Check that `librarian.enabled` is `true` in your config, ollama is running (`ollama serve`), and Gemma 4 E2B is pulled (`ollama pull gemma4:e2b`). The librarian starts as a child of `ll-watch`; it won't run standalone without the watcher. Run `ll-watch status` to check if the watcher is running. Check stderr output with `ll-watch --foreground` for "Waiting for ollama..." or "Librarian disabled in config".

## `ll-search: command not found`

Both `ll-watch` and `ll-search` are stable shell shims that the SessionStart hook auto-installs into `~/.local/bin/`. If `ll-search` is missing, run `node PLUGIN/scripts/install-shims.mjs --install` (or just `node PLUGIN/scripts/install-shims.mjs --check` to see which shims exist). Make sure `~/.local/bin` is on your `PATH`. The shims resolve their targets at runtime, so they survive plugin updates.

## Episodic memory not available

Install episodic-memory first:

```bash
claude plugin install episodic-memory@superpowers-marketplace
```

Restart Claude Code.
