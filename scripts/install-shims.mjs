#!/usr/bin/env node
// Installs ~/.local/bin shims for the learning-loop CLIs.
//
// Usage:
//   node install-shims.mjs                  — install all shims (default)
//   node install-shims.mjs --install        — same (compat alias)
//   node install-shims.mjs --check          — print which shims exist, exit 0
//
// Two shims are written. Both resolve their target at runtime so they survive
// plugin updates.
//
// 1. ~/.local/bin/ll-watch  (POSIX) / %USERPROFILE%\.local\bin\ll-watch.cmd  (Windows)
//    Resolves the latest plugin cache version and exec's its scripts/watch.mjs.
//    Wraps `ll-search watch` with all paths pre-resolved from the user's config.
//
// 2. ~/.local/bin/ll-search  (POSIX) / %USERPROFILE%\.local\bin\ll-search.cmd  (Windows)
//    Resolves PLUGIN_DATA via $CLAUDE_PLUGIN_DATA or the saved
//    ~/.claude/plugins/data/.ll-data-path marker, then exec's
//    $PLUGIN_DATA/bin/ll-search with ORT_DYLIB_PATH and ORT_LIB_LOCATION
//    pointing at the binary's directory (matches scripts/lib/binary.mjs).

import { writeFileSync, mkdirSync, chmodSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { getPluginRoot } from './lib/config.mjs';
import { env } from './lib/env.mjs';

const isWindows = process.platform === 'win32';
const command = process.argv[2] || '--install';

const binDir = join(homedir(), '.local', 'bin');

const llWatchPath = isWindows ? join(binDir, 'll-watch.cmd') : join(binDir, 'll-watch');
const llSearchPath = isWindows ? join(binDir, 'll-search.cmd') : join(binDir, 'll-search');

if (command === '--check' || command === 'check') {
  const w = existsSync(llWatchPath) ? 'installed' : 'missing';
  const s = existsSync(llSearchPath) ? 'installed' : 'missing';
  console.log(`ll-watch:  ${w} (${llWatchPath})`);
  console.log(`ll-search: ${s} (${llSearchPath})`);
  process.exit(0);
}

if (command !== '--install' && command !== 'install') {
  console.error(`unknown command: ${command}`);
  console.error('usage: install-shims.mjs [--install|--check]');
  process.exit(2);
}

mkdirSync(binDir, { recursive: true });

// ── Resolve cache parent for the ll-watch shim ──
const pluginRoot = getPluginRoot();
const cacheBase = join(homedir(), '.claude', 'plugins', 'cache');
const inCache = pluginRoot.startsWith(cacheBase);
const cacheParent = inCache
  ? resolve(pluginRoot, '..')
  : join(cacheBase, 'learning-loop-marketplace', 'learning-loop');

if (isWindows) {
  // ── Windows: .cmd shims ──
  //
  // .cmd files are executed natively by cmd.exe and by `npm run` / PowerShell
  // via cmd.exe delegation. They need no external tooling.
  //
  // PLUGIN_DATA resolution mirrors the POSIX shim, in priority order:
  // 1. %CLAUDE_PLUGIN_DATA% env var (set by Claude Code per session)
  // 2. saved marker at %USERPROFILE%\.claude\plugins\data\.ll-data-path
  // 3. canonical default: %USERPROFILE%\.claude\plugins\data\learning-loop-learning-loop-marketplace

  const llWatchCmdShim = `@echo off
rem ll-watch shim — resolves latest learning-loop plugin version at runtime.
rem Written by: node ...\\scripts\\install-shims.mjs
setlocal enabledelayedexpansion

set "CACHE_DIR=${cacheParent}"
set "LATEST="

rem Find the highest semver-named directory. Uses PowerShell because cmd's
rem built-in sort is alphabetical: "1.10.0" would sort before "1.9.0".
for /f "delims=" %%D in ('powershell -NoProfile -Command "Get-ChildItem '!CACHE_DIR!' -Directory -ErrorAction SilentlyContinue ^| Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' } ^| Sort-Object { [version]$_.Name } ^| Select-Object -Last 1 -ExpandProperty Name"') do (
  set "LATEST=!CACHE_DIR!\\%%D"
)

if "!LATEST!"=="" (
  echo error: learning-loop plugin not found in cache 1>&2
  echo   Run: claude plugin install learning-loop@learning-loop-marketplace 1>&2
  exit /b 1
)

node "!LATEST!\\scripts\\watch.mjs" %*
endlocal
`;

  const llSearchCmdShim = `@echo off
rem ll-search shim — resolves PLUGIN_DATA at runtime and runs the binary.
rem Written by: node ...\\scripts\\install-shims.mjs
setlocal enabledelayedexpansion

set "BIN="

rem Priority 1: CLAUDE_PLUGIN_DATA env var (set by Claude Code per session).
if defined CLAUDE_PLUGIN_DATA (
  if exist "%CLAUDE_PLUGIN_DATA%\\bin\\ll-search.exe" (
    set "BIN=%CLAUDE_PLUGIN_DATA%\\bin\\ll-search.exe"
  )
)

rem Priority 2: saved marker file.
if "!BIN!"=="" (
  set "MARKER=%USERPROFILE%\\.claude\\plugins\\data\\.ll-data-path"
  if exist "!MARKER!" (
    set /p MARKER_VAL=<"!MARKER!"
    if exist "!MARKER_VAL!\\bin\\ll-search.exe" (
      set "BIN=!MARKER_VAL!\\bin\\ll-search.exe"
    )
  )
)

rem Priority 3: canonical default location.
if "!BIN!"=="" (
  set "DEFAULT=%USERPROFILE%\\.claude\\plugins\\data\\learning-loop-learning-loop-marketplace"
  if exist "!DEFAULT!\\bin\\ll-search.exe" (
    set "BIN=!DEFAULT!\\bin\\ll-search.exe"
  )
)

if "!BIN!"=="" (
  echo error: ll-search binary not found 1>&2
  echo   Tried CLAUDE_PLUGIN_DATA, %%USERPROFILE%%\\.claude\\plugins\\data\\.ll-data-path, and the default location. 1>&2
  echo   Run /learning-loop:init to install. 1>&2
  exit /b 1
)

rem Resolve the directory so ORT can find its shared library.
for %%F in ("!BIN!") do set "BIN_DIR=%%~dpF"
rem Strip trailing backslash that %%~dpF appends.
if "!BIN_DIR:~-1!"=="\\" set "BIN_DIR=!BIN_DIR:~0,-1!"

set "ORT_DYLIB_PATH=!BIN_DIR!"
set "ORT_LIB_LOCATION=!BIN_DIR!"
"!BIN!" %*
endlocal
`;

  writeFileSync(llWatchPath, llWatchCmdShim);
  writeFileSync(llSearchPath, llSearchCmdShim);

  console.log(`Wrote ${llWatchPath}`);
  console.log(`Wrote ${llSearchPath}`);
  console.log(`Both shims resolve their targets at runtime — survive plugin updates.`);
  console.log(`\nNOTE: cmd.exe does not add %USERPROFILE%\\.local\\bin to PATH automatically.`);
  console.log(
    `Add it via: setx PATH "%USERPROFILE%\\.local\\bin;%PATH%" (run in cmd.exe, then restart terminal)`,
  );
} else {
  // ── POSIX: bash shims ──

  const llWatchShim = `#!/bin/bash
# ll-watch shim — resolves latest learning-loop plugin version at runtime.
# Written by: node .../scripts/install-shims.mjs
set -euo pipefail

CACHE_DIR="${cacheParent}"
# Filter to version-named dirs (start with a digit) — Claude Code's plugin
# manager leaves orphan hash dirs (e.g. e27a4322c362/) containing only a
# .orphaned_at marker, and sort -V picks letter-prefixed names as "latest".
LATEST="$(ls -d "\${CACHE_DIR}"/[0-9]*/ 2>/dev/null | sort -V | tail -1)"

if [ -z "\${LATEST}" ]; then
  echo "error: learning-loop plugin not found in cache" >&2
  echo "  Run: claude plugin install learning-loop@learning-loop-marketplace" >&2
  exit 1
fi

exec node "\${LATEST}scripts/watch.mjs" "$@"
`;

  // ── ll-search shim ──
  //
  // PLUGIN_DATA resolution, in priority order:
  // 1. $CLAUDE_PLUGIN_DATA env var (set by Claude Code per session)
  // 2. saved marker at ~/.claude/plugins/data/.ll-data-path
  // 3. canonical default: ~/.claude/plugins/data/learning-loop-learning-loop-marketplace
  //
  // Each candidate is only used if its binary exists — this guards against the
  // failure mode where tests stomp the marker file with a temp path via the
  // CLAUDE_PLUGIN_DATA-write side effect in getPluginData().
  //
  // The binary lives at $PLUGIN_DATA/bin/ll-search, downloaded once by /init,
  // not in the plugin cache — so this shim survives plugin updates without
  // re-resolving the cache version.
  const llSearchShim = `#!/bin/bash
# ll-search shim — resolves PLUGIN_DATA at runtime and exec's the binary.
# Written by: node .../scripts/install-shims.mjs
set -euo pipefail

resolve_bin() {
  local pd="\$1"
  if [ -n "\$pd" ] && [ -x "\$pd/bin/ll-search" ]; then
    echo "\$pd/bin/ll-search"
  fi
  return 0
}

read_marker() {
  local f="\$HOME/.claude/plugins/data/.ll-data-path"
  if [ -f "\$f" ]; then cat "\$f"; fi
  return 0
}

BIN="\$(resolve_bin "\${CLAUDE_PLUGIN_DATA:-}")"
[ -z "\$BIN" ] && BIN="\$(resolve_bin "\$(read_marker)")"
[ -z "\$BIN" ] && BIN="\$(resolve_bin "\$HOME/.claude/plugins/data/learning-loop-learning-loop-marketplace")"

if [ -z "\$BIN" ]; then
  echo "error: ll-search binary not found" >&2
  echo "  Tried CLAUDE_PLUGIN_DATA, ~/.claude/plugins/data/.ll-data-path, and the default location." >&2
  echo "  Run /learning-loop:init to install." >&2
  exit 1
fi

BIN_DIR="\$(dirname "\$BIN")"
exec env ORT_DYLIB_PATH="\$BIN_DIR" ORT_LIB_LOCATION="\$BIN_DIR" "\$BIN" "\$@"
`;

  writeFileSync(llWatchPath, llWatchShim);
  chmodSync(llWatchPath, 0o755);

  writeFileSync(llSearchPath, llSearchShim);
  chmodSync(llSearchPath, 0o755);

  console.log(`Wrote ${llWatchPath}`);
  console.log(`Wrote ${llSearchPath}`);
  console.log(`Both shims resolve their targets at runtime — survive plugin updates.`);

  const pathDirs = (env.PATH || '').split(':');
  if (!pathDirs.includes(binDir)) {
    console.log(`\nAdd to your shell rc:  export PATH="$HOME/.local/bin:$PATH"`);
  }
}
