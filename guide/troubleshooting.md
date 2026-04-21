# Troubleshooting

## `/learning-loop:init` hangs on binary download

The `ll-search` binary is ~77MB (includes embedding and reranker models). On slow connections, the download can take a few minutes. If it fails, re-run init.

## Search returns no results

Run `node scripts/vault-search.mjs index --force` to rebuild the index. The index lives in `<vault>/.vault-search/` and survives plugin reinstalls. The Stop hook spawns a detached incremental reindex after each turn, so the index normally stays current without manual intervention.

## Shadow injection log shows 0 passes

First check that the backends are alive. Open a recent shadow record and look at `backends.vault.error` and `backends.episodic.error`.

- If you see `spawn ... ENOENT`, run `/learning-loop:init` to install the binary.
- If `episodic-memory` exits with a NODE_MODULE_VERSION mismatch, rebuild with `npm rebuild --prefix ~/.claude/plugins/cache/superpowers-marketplace/episodic-memory/<version>`.
- If both backends are healthy but the gate never passes, the threshold is too high. Lower `injection_threshold` in `config.json` (or set `LEARNING_LOOP_INJECTION_THRESHOLD`).

## Notes not showing up in vault

Check that `config.json` in `PLUGIN_DATA` (set by `CLAUDE_PLUGIN_DATA` env var) has the correct `vault_path`. If set, the `VAULT_PATH` environment variable overrides it.

## Librarian not starting

Check that `librarian.enabled` is `true` in your config, ollama is running (`ollama serve`), and Gemma 4 E2B is pulled (`ollama pull gemma4:e2b`). The librarian starts as a child of `ll-search watch`; it won't run standalone without the watcher. Check stderr output for "Waiting for ollama..." or "Librarian disabled in config".

## Episodic memory not available

Install episodic-memory first:

```bash
claude plugin install episodic-memory@superpowers-marketplace
```

Restart Claude Code.
