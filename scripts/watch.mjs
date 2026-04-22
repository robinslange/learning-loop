#!/usr/bin/env node
// Launches ll-search watch with all paths resolved from plugin config.
//
// Usage:
//   ll-watch                 — start watcher in background
//   ll-watch --foreground    — start watcher in foreground (for tmux/launchd)
//   ll-watch --install       — write stable shim to ~/.local/bin/ll-watch
//   ll-watch stop            — stop a running watcher
//   ll-watch status          — check watcher status

import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { getPluginRoot, getPluginData, getVaultPath } from './lib/config.mjs';

const command = process.argv[2];

// ── --install: write a stable shim that resolves the latest plugin version at runtime ──
if (command === '--install' || command === 'install') {
  const binDir = join(homedir(), '.local', 'bin');
  const shimPath = join(binDir, 'll-watch');
  mkdirSync(binDir, { recursive: true });

  const pluginRoot = getPluginRoot();
  const cacheBase = join(homedir(), '.claude', 'plugins', 'cache');
  const inCache = pluginRoot.startsWith(cacheBase);
  const cacheParent = inCache
    ? resolve(pluginRoot, '..')
    : join(cacheBase, 'learning-loop-marketplace', 'learning-loop');

  const shim = `#!/bin/bash
# ll-watch shim — resolves latest learning-loop plugin version at runtime.
# Written by: node .../scripts/watch.mjs --install
set -euo pipefail

CACHE_DIR="${cacheParent}"
LATEST="$(ls -d "\${CACHE_DIR}"/*/ 2>/dev/null | sort -V | tail -1)"

if [ -z "\${LATEST}" ]; then
  echo "error: learning-loop plugin not found in cache" >&2
  echo "  Run: claude plugin install learning-loop@learning-loop-marketplace" >&2
  exit 1
fi

exec node "\${LATEST}scripts/watch.mjs" "$@"
`;

  writeFileSync(shimPath, shim);
  chmodSync(shimPath, 0o755);
  console.log(`Wrote shim to ${shimPath}`);
  console.log(`Shim resolves latest plugin version at runtime — survives updates.`);

  const pathDirs = (process.env.PATH || '').split(':');
  if (!pathDirs.includes(binDir)) {
    console.log(`\nAdd to your shell rc:  export PATH="$HOME/.local/bin:$PATH"`);
  }

  process.exit(0);
}

const pluginData = getPluginData();
const pluginRoot = getPluginRoot();
const vault = getVaultPath();

if (!pluginData) { console.error('error: cannot resolve PLUGIN_DATA'); process.exit(1); }
if (!vault)      { console.error('error: vault_path not set in config.json'); process.exit(1); }

const bin = join(pluginData, 'bin', 'll-search');
if (!existsSync(bin)) { console.error('error: ll-search not installed — run /learning-loop:init'); process.exit(1); }

const db = join(pluginData, 'retrieval', 'search.db');
const pidFile = join(pluginData, 'watch.pid');
const librarianScript = join(pluginRoot, 'scripts', 'librarian.mjs');

// ── stop: kill running watcher ──
if (command === 'stop') {
  if (!existsSync(pidFile)) { console.log('No watcher running (no pid file)'); process.exit(0); }
  const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
  try { process.kill(pid, 'SIGTERM'); console.log(`Stopped watcher (pid ${pid})`); }
  catch { console.log(`Watcher not running (stale pid ${pid})`); }
  try { unlinkSync(pidFile); } catch {}
  process.exit(0);
}

// ── status: check if watcher is alive ──
if (command === 'status') {
  if (!existsSync(pidFile)) { console.log('Not running'); process.exit(1); }
  const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
  try { process.kill(pid, 0); console.log(`Running (pid ${pid})`); process.exit(0); }
  catch { console.log(`Not running (stale pid ${pid})`); process.exit(1); }
}

// ── default: start watcher ──
const args = [
  'watch', vault, db,
  '--config-dir', pluginData,
  '--pid-file', pidFile,
];

if (existsSync(librarianScript)) {
  args.push('--librarian-script', librarianScript);
}

const foreground = process.argv.includes('--foreground');

if (foreground) {
  const child = spawn(bin, args, { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 1));
} else {
  const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
  child.unref();
  console.log(`ll-search watch started (pid ${child.pid})`);
  console.log(`  vault:  ${vault}`);
  console.log(`  index:  ${db}`);
  console.log(`  pid:    ${pidFile}`);
}
