# Phase 3: Binary and Dependencies

Present a single confirmation covering all needed work:

```
Dependencies need installing. This will:
  - Download ll-search binary (~77MB)
  - Install packages (sql.js, no native deps)
  - Index your vault (~30s for 2,000 notes)

Proceed?
```

Only list items that are actually needed. After confirmation, run sequentially.

## 3a: Binary Download

```bash
node PLUGIN/scripts/download-binary.mjs
```

Detects the platform and downloads the correct binary from GitHub releases. Extracts to `PLUGIN_DATA/bin/`, sets executable permission, writes `.version`. Skips if the installed version already matches.

## 3b: Verify Vendor Dependencies

Confirm `PLUGIN/vendor/sql-wasm.wasm` exists. All JS dependencies are vendored in `PLUGIN/vendor/` and require no npm install.

## 3b.5: Clean up orphan search.db files

Earlier plugin versions wrote the daemon index to `PLUGIN_DATA/retrieval/search.db`. The current daemon writes to `VAULT/.vault-search/vault-index.db`, so any old `search.db` files are dead weight and create three-way split-brain when a stray hook still reads them.

Best-effort delete (ignore errors), each with its `-shm` and `-wal` siblings:

- `PLUGIN_DATA/retrieval/search.db`
- `PLUGIN_DATA/search.db`
- `PLUGIN_DATA/db/search.db`

Use Node `fs.rmSync(path, { force: true })`. Do not prompt: these files are unconditionally orphaned. If none exist this step is a no-op and silent.

## 3c: Initial Vault Index

Run `ll-search index` to build the search index. Report progress.

## 3d: Install CLI shims

```bash
node PLUGIN/scripts/install-shims.mjs --install
```

Writes two stable shims to `~/.local/bin/`:

- `ll-watch`: resolves the latest plugin cache version at runtime and exec's `scripts/watch.mjs`. Wraps `ll-search watch` with paths pre-resolved from config.
- `ll-search`: resolves `PLUGIN_DATA` (via `$CLAUDE_PLUGIN_DATA` or the `~/.claude/plugins/data/.ll-data-path` marker) and exec's the binary at `$PLUGIN_DATA/bin/ll-search` with the right ORT env vars.

Both shims survive plugin updates because they resolve their targets at runtime. If `~/.local/bin` is not in the user's PATH, inform them to add it. The legacy `node PLUGIN/scripts/watch.mjs --install` still works (it delegates to `install-shims.mjs`).

## 3e: Plugin Dependencies

Run `node PLUGIN/scripts/check-deps.mjs`. For each missing dependency, present it and ask to install:

```
Missing dependency: episodic-memory
Required for: Cross-session conversation search
Install: claude plugin install episodic-memory@superpowers-marketplace
```
