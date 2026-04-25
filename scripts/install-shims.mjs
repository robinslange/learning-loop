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
// 1. ~/.local/bin/ll-watch
//    Resolves the latest plugin cache version and exec's its scripts/watch.mjs.
//    Wraps `ll-search watch` with all paths pre-resolved from the user's config.
//
// 2. ~/.local/bin/ll-search
//    Resolves PLUGIN_DATA via $CLAUDE_PLUGIN_DATA or the saved
//    ~/.claude/plugins/data/.ll-data-path marker, then exec's
//    $PLUGIN_DATA/bin/ll-search with ORT_DYLIB_PATH and ORT_LIB_LOCATION
//    pointing at the binary's directory (matches scripts/lib/binary.mjs).

import { writeFileSync, mkdirSync, chmodSync, existsSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { getPluginRoot } from "./lib/config.mjs";

const command = process.argv[2] || "--install";

const binDir = join(homedir(), ".local", "bin");
const llWatchPath = join(binDir, "ll-watch");
const llSearchPath = join(binDir, "ll-search");

if (command === "--check" || command === "check") {
  const w = existsSync(llWatchPath) ? "installed" : "missing";
  const s = existsSync(llSearchPath) ? "installed" : "missing";
  console.log(`ll-watch:  ${w} (${llWatchPath})`);
  console.log(`ll-search: ${s} (${llSearchPath})`);
  process.exit(0);
}

if (command !== "--install" && command !== "install") {
  console.error(`unknown command: ${command}`);
  console.error("usage: install-shims.mjs [--install|--check]");
  process.exit(2);
}

mkdirSync(binDir, { recursive: true });

// ── Resolve cache parent for the ll-watch shim ──
const pluginRoot = getPluginRoot();
const cacheBase = join(homedir(), ".claude", "plugins", "cache");
const inCache = pluginRoot.startsWith(cacheBase);
const cacheParent = inCache
  ? resolve(pluginRoot, "..")
  : join(cacheBase, "learning-loop-marketplace", "learning-loop");

// ── ll-watch shim ──
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
console.log(
  `Both shims resolve their targets at runtime — survive plugin updates.`,
);

const pathDirs = (process.env.PATH || "").split(":");
if (!pathDirs.includes(binDir)) {
  console.log(`\nAdd to your shell rc:  export PATH="$HOME/.local/bin:$PATH"`);
}
