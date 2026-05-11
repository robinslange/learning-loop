// hooks/session-start/watch-daemon.mjs : ll-search watch daemon lifecycle.
// Guards spawn with a PID-file lock acquired via O_EXCL writeFileSync.
// Checks running version; SIGTERMs outdated daemons.

import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { HookConfig } from '../../scripts/lib/hook-config.mjs';
import { spawnEnv } from '../../scripts/lib/env.mjs';
import { logError } from '../../scripts/lib/log.mjs';

export async function run(ctx) {
  const { pluginDir, pluginData, pluginVersion, vaultRoot } = ctx;

  const { findBinary: findBinaryShared } = await import('../lib/common.mjs');
  const binary = findBinaryShared();

  const DB_PATH = join(vaultRoot, '.vault-search', 'vault-index.db');
  if (!binary || !existsSync(DB_PATH) || !pluginData) return;

  const pidPath = join(pluginData, 'watch.pid');
  const versionPath = join(pluginData, 'watch.version');
  const lockPath = pidPath + '.lock';

  function checkAlive() {
    let raw;
    try {
      raw = readFileSync(pidPath, 'utf8').trim();
    } catch {
      return { state: 'missing' };
    }
    if (raw === '') return { state: 'writer-in-progress' };
    const pid = parseInt(raw, 10);
    if (!Number.isFinite(pid)) return { state: 'corrupt' };
    try {
      process.kill(pid, 0);
      return { state: 'alive', pid };
    } catch {
      return { state: 'dead', pid };
    }
  }

  const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
  function syncSleep(ms) {
    Atomics.wait(sleepBuf, 0, 0, ms);
  }

  let probe = checkAlive();
  if (probe.state === 'writer-in-progress') {
    syncSleep(HookConfig.DAEMON_CHECK_POLL_MS);
    probe = checkAlive();
  }

  let shouldSpawn = true;
  if (probe.state === 'alive') {
    let runningVersion = '';
    try {
      runningVersion = readFileSync(versionPath, 'utf8').trim();
    } catch (err) {
      logError('session-start.watch-daemon.readVersion', err);
    }
    if (runningVersion === pluginVersion) {
      shouldSpawn = false;
    } else {
      try {
        process.kill(probe.pid, 'SIGTERM');
      } catch (err) {
        logError('session-start.watch-daemon.sigterm', err);
      }
      const deadline = Date.now() + HookConfig.DAEMON_STARTUP_DEADLINE_MS;
      while (Date.now() < deadline) {
        const p = checkAlive();
        if (p.state !== 'alive') break;
        syncSleep(HookConfig.DAEMON_CHECK_POLL_MS);
      }
    }
  } else if (probe.state === 'dead' || probe.state === 'corrupt') {
    try {
      rmSync(pidPath, { force: true });
    } catch (err) {
      logError('session-start.watch-daemon.rmPid', err);
    }
  }

  if (shouldSpawn) {
    let lockAcquired = false;
    try {
      writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      lockAcquired = true;
    } catch (err) {
      logError('session-start.watch-daemon.acquireLock', err);
    }

    if (lockAcquired) {
      try {
        const watchArgs = [
          'watch',
          vaultRoot,
          DB_PATH,
          '--config-dir',
          pluginData,
          '--pid-file',
          pidPath,
        ];
        const librarianScript = join(pluginDir, 'scripts', 'librarian.mjs');
        if (existsSync(librarianScript)) {
          watchArgs.push('--librarian-script', librarianScript);
        }
        const child = spawn(binary.bin, watchArgs, {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env: spawnEnv({ ORT_DYLIB_PATH: binary.binDir, ORT_LIB_LOCATION: binary.binDir }),
        });
        child.unref();
      } catch (err) {
        logError('session-start.watch-daemon.spawn', err);
      }
      try {
        rmSync(lockPath, { force: true });
      } catch (err) {
        logError('session-start.watch-daemon.releaseLock', err);
      }
    }
  }
}
