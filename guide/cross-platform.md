# Cross-platform support

learning-loop is built to run on macOS, Linux, and Windows. The core hook layer (Node.js) and the Rust binary (`ll-search`) target all three. This document records what is verified, what is theoretically supported, and what to watch for per platform.

## Supported platforms

| Platform | Architecture | ll-search artifact | Status |
|---|---|---|---|
| macOS | arm64 (Apple Silicon) | `ll-search-darwin-arm64.tar.gz` | Primary development target. All features verified. |
| Linux | x64 (glibc) | `ll-search-linux-x64.tar.gz` | CI-built. Hook layer verified. End-to-end tested by external users. |
| Windows | x64 | `ll-search-windows-x64.zip` | CI-built. Hook layer designed cross-platform. `.cmd` shims installed by `/init`. End-to-end **not** verified by maintainers — please report issues. |

Intel Macs are not currently supported (no prebuilt artifact). Build from source via `cd native && cargo build --release`.

## What works the same on all three

- All Node hooks use `path.join` / `path.resolve`, never hardcoded slashes
- `home()` checks `HOME`, `USERPROFILE`, then `os.homedir()` — works on Windows where `HOME` is undefined
- `binaryName()` and `findBinary()` append `.exe` on Windows
- `findEpisodicBinary()` appends `.exe` on Windows (since v1.15.9)
- `os.tmpdir()` is used everywhere — never `/tmp`, since macOS resolves to `/var/folders/...` and Windows resolves to `%TEMP%`
- `resolveConfig` strips UTF-8 BOM before parsing (since v1.15.9) — Notepad-saved JSON parses correctly
- `download-binary.mjs` extracts `.zip` via tar → PowerShell `Expand-Archive` → `unzip` fallback chain (since v1.15.9)
- All `hooks.json` commands invoke `node` directly with quoted `${CLAUDE_PLUGIN_ROOT}` paths — no shell pipes, heredocs, or bash-only syntax

## Known caveats per platform

### Windows

- **CLI shims are `.cmd` files.** `/init` writes `ll-watch.cmd` and `ll-search.cmd` to `%USERPROFILE%\.local\bin\`. cmd.exe does not add this directory to `PATH` automatically. After install, run once in cmd.exe: `setx PATH "%USERPROFILE%\.local\bin;%PATH%"` then restart your terminal. PowerShell `.ps1` shims are not currently generated — the `.cmd` files work in both cmd.exe and PowerShell.
- **`appendFileSync` is not atomic.** POSIX provides kernel-level `O_APPEND` atomicity for writes under `PIPE_BUF` (4096 bytes); Windows does not. Concurrent hook processes appending to the same JSONL log can interleave records. In practice, the only hooks that append concurrently are the per-event provenance/retrieval logs, and turn-level concurrency is low. If you observe corrupted log records, it is likely this. The pre-existing `feedback_crossplatform_atomicity.md` memory tracks this.
- **`process.kill(pid, 'SIGTERM')` is unconditional.** No graceful-shutdown semantics. The injection pipeline's race-cap abort already treats SIGTERM as "kill now," so this is not a behavioral change.
- **`fs.rename()` can throw EXDEV** when temp and destination are on different volumes, or when a cloud sync filter (Dropbox, OneDrive) intercepts the rename. learning-loop does not use rename-after-write atomic patterns; this affects Claude Code itself more than this plugin (see anthropics/claude-code issues #25476, #42119).
- **MAX_PATH (260 chars)** can bite very deep vault hierarchies. Enable long path support in Group Policy + application manifest if you hit it.
- **Native Rust build from source requires curl.exe** (Windows 10 1803+ ships it) — only relevant if you build with the `nli` cargo feature locally. Pre-built binaries from CI do not need it on the install machine.
- **Detached child + `stdio: 'ignore'` is required for long-running child processes.** Setting stdio to inherited file descriptors keeps the parent event loop blocked even after `child.unref()`. `watch-daemon.mjs` spawns `ll-search watch` with `detached: true, stdio: 'ignore'` to satisfy this constraint.
- **Federation seed uses Windows Credential Manager.** The `keyring` crate maps to `wincred` on Windows; no additional system deps. End-to-end federation flows on Windows are not maintainer-verified — please report issues.

### Linux

- glibc only. musl distributions (Alpine) are not currently a build target. Open an issue if you need it.
- The bundled `ll-search` binary statically links its ONNX runtime; the only runtime system dependency is libc.
- `ORT_DYLIB_PATH` and `ORT_LIB_LOCATION` are set automatically by `findBinary` so the loader finds the bundled `libonnxruntime.so`.
- **Build-from-source needs `libdbus-1-dev` + `pkg-config`.** Since v1.18.0 the federation signing seed uses the `keyring` crate with the `sync-secret-service` feature, which transitively pulls `libdbus-sys`. A stock `ubuntu-latest` image lacks the DBus headers and `cargo build` fails. Install with `sudo apt-get install -y libdbus-1-dev pkg-config` before invoking cargo. CI installs the package as the first step of the `Test` and `Build ll-search` workflows. Pre-built binaries from CI bundle their deps; this only affects local source builds.
- **Federation seed backend selection.** On desktop installs with a running DBus session, the seed lives in Secret Service (gnome-keyring, kwallet, KeePassXC's Secret Service plugin, etc.). On headless servers without DBus, `ll-search` falls back to encrypted-at-rest (chacha20poly1305 sealed with a `machine-uid` derived key). See [Federation > Seed storage](federation.md#seed-storage).

### macOS

- Apple Silicon arm64 only as a prebuilt artifact. Intel Macs must build from source.
- Gatekeeper may quarantine the freshly downloaded `ll-search` binary on first run. If you see "cannot be opened because the developer cannot be verified," run `xattr -d com.apple.quarantine "$CLAUDE_PLUGIN_DATA/bin/ll-search"`.
- `os.tmpdir()` is `/var/folders/.../T/`, not `/tmp`. Code that hardcoded `/tmp` would silently use a different (writable but separate) directory and miss state.
- **Federation seed lives in Keychain.** The `keyring` crate uses the macOS Keychain Services API; no additional system deps. Entries are namespaced by `config_dir` (`signing-seed-v1-<8-hex>`) so multiple installs on the same machine don't collide.
- **Librarian pauses on battery (since v1.18.0).** `scripts/librarian.mjs` polls `pmset -g batt` at the top of each iteration and sleeps `battery_poll_seconds` (default 60) while on `'Battery Power'`. Disable with `librarian.pause_on_battery: false` in config if you want it to run unplugged.

## Verification

Run the cross-platform smoke test against your install:

```bash
# Confirm the watch daemon started and wrote its pidfile
VAULT_PIDFILE="$(node -e "const c=require(process.env.CLAUDE_PLUGIN_DATA+'/config.json'); console.log(c.vault_path+'/.vault-search/watch.pid')")"
cat "$VAULT_PIDFILE"                         # prints a numeric PID
kill -0 "$(cat "$VAULT_PIDFILE")" && echo "watcher alive" || echo "watcher not running"

# Query the daemon directly to confirm it can serve results
node scripts/vault-search.mjs query "test" --limit 1
```

The watch daemon is spawned at SessionStart by `hooks/session-start/watch-daemon.mjs`. If the pidfile is missing or the process is gone, start a new session or run `node scripts/watch.mjs start` to relaunch it manually.

## Reporting issues

If you hit a platform-specific problem, please include:

- OS + version (`sw_vers` / `lsb_release -a` / `winver`)
- Node version (`node --version`)
- learning-loop version (`cat $CLAUDE_PLUGIN_DATA/bin/.version`)
- The failing hook or skill, plus any stderr output captured from it

File at https://github.com/robinslange/learning-loop/issues.
