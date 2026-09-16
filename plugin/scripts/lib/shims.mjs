// scripts/lib/shims.mjs : the text of the ~/.local/bin shims.
//
// A shim is written once and then outlives every plugin version, so it holds
// nothing a release could need to change. It finds the install Claude Code has
// active (or the newest Codex cache version when Claude Code has none) and hands
// its name and arguments to that install's scripts/shim.mjs, where what each
// shim does lives and updates with the plugin. The text carries no machine or
// version path, so every version renders the same bytes and SessionStart can
// spot a stale shim by comparing content (cache-cleanup.mjs).
//
// LOCATE is one line of CommonJS for `node -e`, shared by both platforms. It
// avoids double quotes, backticks and % so the same bytes survive a POSIX
// double-quoted string and cmd.exe. `$` is fine -- it shows up in the version
// regex below and is literal in both shells there. `!` is safe too: the
// non-search .cmd shims carry `setlocal DisableDelayedExpansion`, so cmd.exe
// never reads `!root!` as a delayed-expansion reference -- without that, a
// machine with delayed expansion on by default
// (HKCU\Software\Microsoft\Command Processor) would strip everything between
// the `!` pairs in LOCATE and corrupt the script. `--` stops node from
// reading the shim's own flags (`ll-paths --sh`). The argv splice makes
// shim.mjs see the argv it would get if node had been handed it directly.
//
// Candidates are tried in order and the first whose scripts/shim.mjs exists
// wins: the installed_plugins.json record, then the newest version under the
// Claude Code cache, then the newest under the Codex cache. A record pointing
// at a directory that no longer exists (or a different marketplace key) no
// longer hard-fails when a good version still sits in a cache.

import { INSTALL_KEY } from './plugin-meta.mjs';

const LOCATE = [
  "const fs=require('node:fs'),path=require('node:path'),home=require('node:os').homedir();",
  `const key='${INSTALL_KEY}';`,
  "function newest(base){try{const v=fs.readdirSync(base).filter((d)=>/^\\d+\\.\\d+\\.\\d+$/.test(d)).sort((a,b)=>a.localeCompare(b,'en',{numeric:true})).pop();return v?path.join(base,v):null}catch{return null}}",
  'let installed;',
  "try{const j=JSON.parse(fs.readFileSync(path.join(home,'.claude','plugins','installed_plugins.json'),'utf8'));installed=(j.plugins||j)[key][0].installPath}catch{}",
  "const candidates=[installed,newest(path.join(home,'.claude','plugins','cache','learning-loop-marketplace','learning-loop')),newest(path.join(home,'.codex','plugins','cache','learning-loop-marketplace','learning-loop'))];",
  "const root=candidates.find((r)=>r&&fs.existsSync(path.join(r,'scripts','shim.mjs')));",
  "if(!root){console.error('learning-loop is not installed. Run: claude plugin install '+key);process.exit(1)}",
  "const shim=path.join(root,'scripts','shim.mjs');",
  'process.argv.splice(1,0,shim);',
  "import(require('node:url').pathToFileURL(shim).href);",
].join('');

// ll-search is the exception, because skills call it in loops. Its binary lives
// in plugin-data, which no plugin version owns, so it has nothing to locate and
// does its whole job in the shell. Measured 2026-09-15: 6ms as builtins-only sh
// (no subshells, no forks before exec), 12ms as the old bash shim, 34ms routed
// through node, whose startup alone is ~20ms. Logic here can still change
// freely: SessionStart rewrites the shim whenever this text does.
const SEARCH_SH = [
  'm=',
  '[ -r "$HOME/.claude/plugins/data/.ll-data-path" ] && read -r m < "$HOME/.claude/plugins/data/.ll-data-path"',
  'for pd in "${CLAUDE_PLUGIN_DATA:-}" "$m" "$HOME/.claude/plugins/data/learning-loop-learning-loop-marketplace"; do',
  '  if [ -n "$pd" ] && [ -x "$pd/bin/ll-search" ]; then',
  '    dir="$pd/bin"',
  '    for lib in "$dir"/libonnxruntime*; do',
  '      [ -e "$lib" ] && export ORT_DYLIB_PATH="$dir" ORT_LIB_LOCATION="$dir"',
  '      break',
  '    done',
  '    exec "$dir/ll-search" "$@"',
  '  fi',
  'done',
  'echo "error: ll-search binary not found" >&2',
  'echo "  Tried: \\$CLAUDE_PLUGIN_DATA, \\$HOME/.claude/plugins/data/.ll-data-path, \\$HOME/.claude/plugins/data/learning-loop-learning-loop-marketplace" >&2',
  'echo "  Run /learning-loop:init to install." >&2',
  'exit 1',
];

// The cmd.exe ll-search body. renderShim supplies the shared @echo off / rem
// header (below), so this is the body only -- install-shims.mjs used to own
// the whole file including that header. The "Tried ..." diagnostic mirrors
// SEARCH_SH's.
const SEARCH_CMD = String.raw`setlocal enabledelayedexpansion
set "BIN="
if defined CLAUDE_PLUGIN_DATA (
  if exist "%CLAUDE_PLUGIN_DATA%\bin\ll-search.exe" (
    set "BIN=%CLAUDE_PLUGIN_DATA%\bin\ll-search.exe"
  )
)
if "!BIN!"=="" (
  set "MARKER=%USERPROFILE%\.claude\plugins\data\.ll-data-path"
  if exist "!MARKER!" (
    set /p MARKER_VAL=<"!MARKER!"
    if exist "!MARKER_VAL!\bin\ll-search.exe" (
      set "BIN=!MARKER_VAL!\bin\ll-search.exe"
    )
  )
)
if "!BIN!"=="" (
  set "DEFAULT=%USERPROFILE%\.claude\plugins\data\learning-loop-learning-loop-marketplace"
  if exist "!DEFAULT!\bin\ll-search.exe" (
    set "BIN=!DEFAULT!\bin\ll-search.exe"
  )
)
if "!BIN!"=="" (
  echo error: ll-search binary not found 1>&2
  echo   Tried: %CLAUDE_PLUGIN_DATA%, %USERPROFILE%\.claude\plugins\data\.ll-data-path, %USERPROFILE%\.claude\plugins\data\learning-loop-learning-loop-marketplace 1>&2
  echo   Run /learning-loop:init to install. 1>&2
  exit /b 1
)
for %%F in ("!BIN!") do set "BIN_DIR=%%~dpF"
if "!BIN_DIR:~-1!"=="\" set "BIN_DIR=!BIN_DIR:~0,-1!"
if exist "!BIN_DIR!\onnxruntime.dll" (
  set "ORT_DYLIB_PATH=!BIN_DIR!"
  set "ORT_LIB_LOCATION=!BIN_DIR!"
)
"!BIN!" %*
endlocal`.split('\n');

/**
 * @param {string} name  one of SHIM_NAMES
 * @param {string} [platform]
 * @returns {string}
 */
export function renderShim(name, platform = process.platform) {
  const win = platform === 'win32';
  const run = `node -e "${LOCATE}" -- ${name}`;
  const body =
    name === 'll-search'
      ? win
        ? SEARCH_CMD
        : SEARCH_SH
      : win
        ? ['setlocal DisableDelayedExpansion', `${run} %*`]
        : [`exec ${run} "$@"`];
  const note = `${name}: learning-loop shim. The plugin rewrites it when this text changes.`;
  const lines = win ? ['@echo off', `rem ${note}`, ...body] : ['#!/bin/sh', `# ${note}`, ...body];
  const eol = win ? '\r\n' : '\n';
  return lines.join(eol) + eol;
}
