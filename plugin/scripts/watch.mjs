#!/usr/bin/env node
// Launches ll-search watch with all paths resolved from plugin config.
//
// Usage:
//   ll-watch                 — start watcher in background
//   ll-watch --foreground    — start watcher in foreground (for tmux/launchd)
//   ll-watch --install       — write stable shim to ~/.local/bin/ll-watch
//   ll-watch stop            — stop a running watcher
//   ll-watch status          — check watcher status
//   ll-watch --help          — show this help

import { spawn, spawnSync } from 'child_process';
import { existsSync, openSync, readFileSync, unlinkSync } from 'fs';
import { setTimeout as delay } from 'timers/promises';
import { dirname, join } from 'path';
import { getPluginRoot, getPluginData, getVaultPath } from './lib/config.mjs';
import { ortSpawnEnv } from './lib/binary.mjs';
import { logError } from './lib/log.mjs';
import { isProcessAlive } from './lib/file-lock.mjs';

const USAGE = `Usage:
  ll-watch                 — start watcher in background
  ll-watch --foreground    — start watcher in foreground (for tmux/launchd)
  ll-watch stop            — stop a running watcher
  ll-watch status          — check watcher status
  ll-watch --install       — reinstall ~/.local/bin shims
  ll-watch --help          — show this help`;

const command = process.argv[2];

// ── --help: print usage, exit 0 ──
if (command === '--help' || command === '-h' || command === 'help') {
  console.log(USAGE);
  process.exit(0);
}

// ── --install: delegate to install-shims.mjs (canonical multi-shim installer) ──
if (command === '--install' || command === 'install') {
  const installer = join(import.meta.dirname, 'install-shims.mjs');
  const result = spawnSync('node', [installer, '--install'], {
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
}

// ── reject unknown commands before resolving anything heavy ──
const isStart = command === undefined || command === '--foreground';
if (!isStart && command !== 'stop' && command !== 'status') {
  console.error(`unknown command: ${command}`);
  console.error(USAGE);
  process.exit(2);
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
const pidFile = join(vault, '.vault-search', 'watch.pid');
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
  } catch (err) {
    logError('watch.stop.sigterm', err);
    console.log(`Watcher not running (stale pid ${pid})`);
  }
  try {
    unlinkSync(pidFile);
  } catch (err) {
    logError('watch.stop.unlinkPid', err);
  }
  process.exit(0);
}

// ── status: check if watcher is alive ──
if (command === 'status') {
  if (!existsSync(pidFile)) {
    console.log('Not running');
    process.exit(1);
  }
  const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
  if (isProcessAlive(pid)) {
    console.log(`Running (pid ${pid})`);
    process.exit(0);
  }
  console.log(`Not running (stale pid ${pid})`);
  process.exit(1);
}

// ── start: refuse if a watcher is already alive, then spawn the binary ──

if (existsSync(pidFile)) {
  const existingPid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
  if (Number.isFinite(existingPid) && isProcessAlive(existingPid)) {
    console.error(`Watcher already running (pid ${existingPid})`);
    console.error(`Run 'll-watch stop' first, or 'll-watch status' to verify.`);
    process.exit(1);
  }
  // stale pid file — fall through; the binary will overwrite it
}

const args = ['watch', vault, db, '--config-dir', pluginData, '--pid-file', pidFile];

if (existsSync(librarianScript)) {
  args.push('--librarian-script', librarianScript);
}

const foreground = command === '--foreground';

const ortEnv = ortSpawnEnv(dirname(bin));

if (foreground) {
  const child = spawn(bin, args, { stdio: 'inherit', env: ortEnv });
  child.on('exit', (code) => process.exit(code ?? 1));
} else {
  const logPath = join(pluginData, 'watch.log');
  const logFd = openSync(logPath, 'a');
  const child = spawn(bin, args, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: ortEnv,
  });
  child.unref();

  // Confirm the binary survived past its early-exit window before claiming
  // success. The Rust side fails fast on pid-file conflict and on missing
  // ORT shared libraries — both happen well within 300ms.
  await delay(300);
  if (!isProcessAlive(child.pid)) {
    let tail = '(no output)';
    try {
      const lines = readFileSync(logPath, 'utf8').trim().split('\n');
      tail = lines.slice(-5).join('\n') || tail;
    } catch (readErr) {
      logError('watch.start.readLog', readErr);
    }
    console.error(`Watcher failed to start. Last log lines from ${logPath}:`);
    console.error(tail);
    process.exit(1);
  }

  console.log(`ll-search watch started (pid ${child.pid})`);
  console.log(`  vault:  ${vault}`);
  console.log(`  index:  ${db}`);
  console.log(`  pid:    ${pidFile}`);
  console.log(`  log:    ${logPath}`);
}
