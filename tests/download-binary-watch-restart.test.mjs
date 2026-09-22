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

// waitForPidExit is the poll loop that stands between "watch.mjs stop sent
// SIGTERM" and "safe to spawn the replacement daemon": stop does not wait for
// the old process to release its UDS socket, so spawning immediately risks
// the new daemon refusing to start with the socket still held.
test('waitForPidExit: resolves true once the process actually exits', async () => {
  const { waitForPidExit } = await import(pathToFileURL(MOD_PATH).href);
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 500)']);
  try {
    const result = waitForPidExit(child.pid, 3000, 20);
    child.kill();
    assert.equal(await result, true);
  } finally {
    child.kill();
  }
});

test('waitForPidExit: resolves false when the process outlives the timeout', async () => {
  const { waitForPidExit } = await import(pathToFileURL(MOD_PATH).href);
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)']);
  try {
    assert.equal(await waitForPidExit(child.pid, 100, 20), false);
  } finally {
    child.kill();
  }
});

// waitForNewDaemonPid is the other half of the restart wait: after the spawn
// it must see a pidfile naming a LIVE pid that is not the old one.
test('waitForNewDaemonPid: resolves the new pid once the pidfile names a different live process', async () => {
  const { waitForNewDaemonPid } = await import(pathToFileURL(MOD_PATH).href);
  const vault = mkdtempSync(join(tmpdir(), 'll-dl-newpid-'));
  mkdirSync(join(vault, '.vault-search'), { recursive: true });
  const pidfile = join(vault, '.vault-search', 'watch.pid');
  const oldPid = 999999;
  writeFileSync(pidfile, String(oldPid));
  // Flip the pidfile to this test's own (live) pid part-way through the poll.
  const timer = setTimeout(() => writeFileSync(pidfile, String(process.pid)), 60);
  try {
    assert.equal(await waitForNewDaemonPid(vault, oldPid, 3000, 20), process.pid);
  } finally {
    clearTimeout(timer);
    rmSync(vault, { recursive: true, force: true });
  }
});

test('waitForNewDaemonPid: resolves null when the pidfile never changes from the old pid', async () => {
  const { waitForNewDaemonPid } = await import(pathToFileURL(MOD_PATH).href);
  const vault = mkdtempSync(join(tmpdir(), 'll-dl-newpid-stale-'));
  mkdirSync(join(vault, '.vault-search'), { recursive: true });
  // The old daemon is this process, still alive, still named in the pidfile.
  writeFileSync(join(vault, '.vault-search', 'watch.pid'), String(process.pid));
  try {
    assert.equal(await waitForNewDaemonPid(vault, process.pid, 100, 20), null);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});
