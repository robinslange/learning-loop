# Cross-platform support

learning-loop is built to run on macOS, Linux, and Windows. The core hook layer (Node.js) and the Rust binary (`ll-search`) target all three. This document records what is verified, what is theoretically supported, and what to watch for per platform.

## Supported platforms

| Platform | Architecture | ll-search artifact | Status |
|---|---|---|---|
| macOS | arm64 (Apple Silicon) | `ll-search-darwin-arm64.tar.gz` | Primary development target. All features verified. |
| Linux | x64 (glibc) | `ll-search-linux-x64.tar.gz` | CI-built. Hook layer verified. End-to-end tested by external users. |
| Windows | x64 | `ll-search-windows-x64.zip` | CI-built. Hook layer designed cross-platform. End-to-end **not** verified by maintainers — please report issues. |

Intel Macs are not currently supported (no prebuilt artifact). Build from source via `cd native && cargo build --release`.

## What works the same on all three

- All Node hooks use `path.join` / `path.resolve`, never hardcoded slashes
- `home()` checks `HOME`, `USERPROFILE`, then `os.homedir()` — works on Windows where `HOME` is undefined
- `binaryName()` and `findBinary()` append `.exe` on Windows
- `findEpisodicBinary()` appends `.exe` on Windows (since v1.15.9)
- `os.tmpdir()` is used everywhere — never `/tmp`, since macOS resolves to `/var/folders/...` and Windows resolves to `%TEMP%`
- `resolveConfig` strips UTF-8 BOM before parsing (since v1.15.9) — Notepad-saved JSON parses correctly
- `download-binary.mjs` extracts `.zip` via tar → PowerShell `Expand-Archive` → `unzip` fallback chain (since v1.15.9)
- `post-stop-reindex.js` uses `stdio: 'ignore'` with `detached: true` — required on Windows since inherited file descriptors keep the parent event loop open
- All `hooks.json` commands invoke `node` directly with quoted `${CLAUDE_PLUGIN_ROOT}` paths — no shell pipes, heredocs, or bash-only syntax

## Known caveats per platform

### Windows

- **`appendFileSync` is not atomic.** POSIX provides kernel-level `O_APPEND` atomicity for writes under `PIPE_BUF` (4096 bytes); Windows does not. Concurrent hook processes appending to the same JSONL log can interleave records. In practice, the only hooks that append concurrently are the per-event provenance/retrieval logs, and turn-level concurrency is low. If you observe corrupted log records, it is likely this. The pre-existing `feedback_crossplatform_atomicity.md` memory tracks this.
- **`process.kill(pid, 'SIGTERM')` is unconditional.** No graceful-shutdown semantics. The injection pipeline's race-cap abort already treats SIGTERM as "kill now," so this is not a behavioral change.
- **`fs.rename()` can throw EXDEV** when temp and destination are on different volumes, or when a cloud sync filter (Dropbox, OneDrive) intercepts the rename. learning-loop does not use rename-after-write atomic patterns; this affects Claude Code itself more than this plugin (see anthropics/claude-code issues #25476, #42119).
- **MAX_PATH (260 chars)** can bite very deep vault hierarchies. Enable long path support in Group Policy + application manifest if you hit it.
- **Native Rust build from source requires curl.exe** (Windows 10 1803+ ships it) — only relevant if you build with the `nli` cargo feature locally. Pre-built binaries from CI do not need it on the install machine.
- **Detached child + `stdio: 'ignore'` is required.** Setting stdio to inherited file descriptors keeps the parent event loop blocked even after `child.unref()`. The post-stop-reindex hook is built to this constraint.

### Linux

- glibc only. musl distributions (Alpine) are not currently a build target. Open an issue if you need it.
- The bundled `ll-search` binary statically links its ONNX runtime; the only system dependency is libc.
- `ORT_DYLIB_PATH` and `ORT_LIB_LOCATION` are set automatically by `findBinary` so the loader finds the bundled `libonnxruntime.so`.

### macOS

- Apple Silicon arm64 only as a prebuilt artifact. Intel Macs must build from source.
- Gatekeeper may quarantine the freshly downloaded `ll-search` binary on first run. If you see "cannot be opened because the developer cannot be verified," run `xattr -d com.apple.quarantine "$CLAUDE_PLUGIN_DATA/bin/ll-search"`.
- `os.tmpdir()` is `/var/folders/.../T/`, not `/tmp`. Code that hardcoded `/tmp` would silently use a different (writable but separate) directory and miss state.

## Verification

Run the cross-platform smoke test against your install:

```bash
# Hook layer self-test (no network required)
node hooks/post-stop-reindex.js < /dev/null  # exits silently — no input

# Verbose trace
LL_REINDEX_DEBUG=1 echo '{"stop_hook_active": false}' | node hooks/post-stop-reindex.js
```

The debug trace prints every gate decision and the spawned child PID. The lockfile is written to `os.tmpdir()/learning-loop-reindex.lock` — inspect with `cat "$(node -e 'console.log(require("os").tmpdir())')/learning-loop-reindex.lock"`.

## Reporting issues

If you hit a platform-specific problem, please include:

- OS + version (`sw_vers` / `lsb_release -a` / `winver`)
- Node version (`node --version`)
- learning-loop version (`cat $CLAUDE_PLUGIN_DATA/bin/.version`)
- The failing hook or skill, plus stderr output from `LL_REINDEX_DEBUG=1` if relevant

File at https://github.com/robinslange/learning-loop/issues.
