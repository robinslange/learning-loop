// tests/download-binary-watch-restart.test.mjs : watchDaemonIsRunning in
// scripts/download-binary.mjs.
//
// After a successful binary download, a watch daemon already running still
// holds the OLD process image and OLD --librarian-script path until someone
// restarts it. watchDaemonIsRunning(vault) is the pure decision function that
// gates the restart: true only when the pidfile names a pid that is actually
// alive, so a stale or missing pidfile does not trigger a pointless stop/start.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MOD_PATH = fileURLToPath(new URL('../plugin/scripts/download-binary.mjs', import.meta.url));

test('watchDaemonIsRunning: false when no pidfile exists', async () => {
  const { watchDaemonIsRunning } = await import(pathToFileURL(MOD_PATH).href);
  const vault = mkdtempSync(join(tmpdir(), 'll-dlrestart-nopid-'));
  try {
    assert.equal(watchDaemonIsRunning(vault), false);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('watchDaemonIsRunning: false when the pidfile names a dead pid', async () => {
  const { watchDaemonIsRunning } = await import(pathToFileURL(MOD_PATH).href);
  const vault = mkdtempSync(join(tmpdir(), 'll-dlrestart-stale-'));
  try {
    mkdirSync(join(vault, '.vault-search'), { recursive: true });
    // PID unlikely to be alive: max PID range on a fresh temp assertion.
    writeFileSync(join(vault, '.vault-search', 'watch.pid'), '999999\n');
    assert.equal(watchDaemonIsRunning(vault), false);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('watchDaemonIsRunning: true when the pidfile names the current live process', async () => {
  const { watchDaemonIsRunning } = await import(pathToFileURL(MOD_PATH).href);
  const vault = mkdtempSync(join(tmpdir(), 'll-dlrestart-live-'));
  try {
    mkdirSync(join(vault, '.vault-search'), { recursive: true });
    // This test process is guaranteed alive for the duration of the assertion.
    writeFileSync(join(vault, '.vault-search', 'watch.pid'), String(process.pid));
    assert.equal(watchDaemonIsRunning(vault), true);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});
