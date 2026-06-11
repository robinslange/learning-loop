# Phase 3: Binary and Dependencies

Present a single confirmation covering all needed work:

```
Dependencies need installing. This will:
  - Download ll-search binary (~290MB)
  - Install packages (sql.js, no native deps)
  - Index your vault (~30s for 2,000 notes)

Proceed?
```

Only list items that are actually needed. After confirmation, run sequentially.

## 3a: Binary Download

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/download-binary.mjs
```

Detects the platform and downloads the correct binary from GitHub releases. Extracts to `PLUGIN_DATA/bin/`, sets executable permission, writes `.version`. Skips if the installed version already matches.

## 3b: Verify Vendor Dependencies

Confirm `${CLAUDE_PLUGIN_ROOT}/vendor/sql-wasm.wasm` exists. All JS dependencies are vendored in `${CLAUDE_PLUGIN_ROOT}/vendor/` and require no npm install.

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
node ${CLAUDE_PLUGIN_ROOT}/scripts/install-shims.mjs --install
```

Writes two stable shims to `~/.local/bin/`:

- `ll-watch`: resolves the latest plugin cache version at runtime and exec's `scripts/watch.mjs`. Wraps `ll-search watch` with paths pre-resolved from config.
- `ll-search`: resolves `PLUGIN_DATA` (via `$CLAUDE_PLUGIN_DATA` or the `~/.claude/plugins/data/.ll-data-path` marker) and exec's the binary at `$PLUGIN_DATA/bin/ll-search` with the right ORT env vars.

Both shims survive plugin updates because they resolve their targets at runtime. If `~/.local/bin` is not in the user's PATH, inform them to add it. The legacy `node ${CLAUDE_PLUGIN_ROOT}/scripts/watch.mjs --install` still works (it delegates to `install-shims.mjs`).

## 3e.5: Optional - ygrep (local indexed code search)

Used by `/learning-loop:ingest repo` deep mappers when scanning large repos. Skip if the user does not plan to ingest codebases.

Detect: `command -v ygrep >/dev/null 2>&1`. If present, skip this step entirely (no prompt).

If absent, ask once via `AskUserQuestion`:

> Install ygrep (~34 MB local indexed code search)? Used by `/learning-loop:ingest repo` deep mappers. Skip if you don't plan to ingest codebases.

If the user declines, do not prompt again on subsequent `/init` runs (the absence of ygrep is not an error, just a degraded mode for ingest).

If approved:

```bash
PLATFORM=$(uname -sm | tr ' ' '-' | tr '[:upper:]' '[:lower:]')
case "$PLATFORM" in
  darwin-arm64)  ASSET_PATTERN="darwin-arm64" ;;
  darwin-x86_64) ASSET_PATTERN="darwin-x86_64" ;;
  linux-x86_64)  ASSET_PATTERN="linux-x86_64" ;;
  *) echo "ygrep not available for $PLATFORM"; exit 0 ;;
esac

URL=$(curl -s https://api.github.com/repos/yetidevworks/ygrep/releases/latest \
  | grep "browser_download_url.*$ASSET_PATTERN" \
  | head -1 \
  | sed 's/.*: "//;s/".*//')

if [ -z "$URL" ]; then
  echo "Could not resolve ygrep release URL for $PLATFORM"
  exit 0
fi

mkdir -p "$HOME/.local/bin"
curl -sL "$URL" | tar xz -C /tmp
mv /tmp/ygrep "$HOME/.local/bin/ygrep"
chmod +x "$HOME/.local/bin/ygrep"
ygrep --version
```

Idempotent: re-running when `ygrep` is already on PATH is a no-op (the `command -v` short-circuits before the prompt).

## 3e: Plugin Dependencies

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/check-deps.mjs`. For each entry where `status !== "installed"`, present it using the `required` field to set urgency.

For required deps (`required: true`) — block until the user confirms or explicitly declines:

```
Required dependency missing: episodic-memory
Reason: Cross-session conversation search for retrieval, /discovery, /reflect, /refresh
Install: claude plugin install episodic-memory@superpowers-marketplace
```

For optional deps (`required: false`) — present once, accept "skip" without further prompting:

```
Optional dependency missing: <name>
Reason: <reason>
Install (optional): claude plugin install <name>@<marketplace>
```
