#!/usr/bin/env node
// Launches ll-search watch with all paths resolved from plugin config.
//
// Usage:
//   ll-watch                 — start watcher in background
//   ll-watch --foreground    — start watcher in foreground (for tmux/launchd)
//   ll-watch --install       — write stable shim to ~/.local/bin/ll-watch
//   ll-watch stop            — stop a running watcher
//   ll-watch status          — check watcher status

import { spawn, spawnSync } from 'child_process';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { getPluginRoot, getPluginData, getVaultPath } from './lib/config.mjs';

const command = process.argv[2];

// ── --install: delegate to install-shims.mjs (canonical multi-shim installer) ──
if (command === '--install' || command === 'install') {
  const installer = join(import.meta.dirname, 'install-shims.mjs');
  const result = spawnSync('node', [installer, '--install'], {
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
}

const pluginData = getPluginData();
const pluginRoot = getPluginRoot();
const vault = getVaultPath();

if (!pluginData) {
  console.error('error: cannot resolve PLUGIN_DATA');
  process.exit(1);
}
if (!vault) {
  console.error('error: vault_path not set in config.json');
  process.exit(1);
}

const bin = join(pluginData, 'bin', 'll-search');
if (!existsSync(bin)) {
  console.error('error: ll-search not installed — run /learning-loop:init');
  process.exit(1);
}

const db = join(vault, '.vault-search', 'vault-index.db');
const pidFile = join(pluginData, 'watch.pid');
const librarianScript = join(pluginRoot, 'scripts', 'librarian.mjs');

// ── stop: kill running watcher ──
if (command === 'stop') {
  if (!existsSync(pidFile)) {
    console.log('No watcher running (no pid file)');
    process.exit(0);
  }
  const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`Stopped watcher (pid ${pid})`);
  } catch {
    console.log(`Watcher not running (stale pid ${pid})`);
  }
  try {
    unlinkSync(pidFile);
  } catch {}
  process.exit(0);
}

// ── status: check if watcher is alive ──
if (command === 'status') {
  if (!existsSync(pidFile)) {
    console.log('Not running');
    process.exit(1);
  }
  const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
  try {
    process.kill(pid, 0);
    console.log(`Running (pid ${pid})`);
    process.exit(0);
  } catch {
    console.log(`Not running (stale pid ${pid})`);
    process.exit(1);
  }
}

// ── default: start watcher ──
const args = ['watch', vault, db, '--config-dir', pluginData, '--pid-file', pidFile];

if (existsSync(librarianScript)) {
  args.push('--librarian-script', librarianScript);
}

const foreground = process.argv.includes('--foreground');

const ortEnv = { ...process.env, ORT_DYLIB_PATH: dirname(bin), ORT_LIB_LOCATION: dirname(bin) };

if (foreground) {
  const child = spawn(bin, args, { stdio: 'inherit', env: ortEnv });
  child.on('exit', (code) => process.exit(code ?? 1));
} else {
  const child = spawn(bin, args, { detached: true, stdio: 'ignore', env: ortEnv });
  child.unref();
  console.log(`ll-search watch started (pid ${child.pid})`);
  console.log(`  vault:  ${vault}`);
  console.log(`  index:  ${db}`);
  console.log(`  pid:    ${pidFile}`);
}
