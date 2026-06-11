// hooks/session-start/watch-daemon.mjs : ll-search watch daemon lifecycle.
// Guards spawn with file-lock.mjs acquireLock (O_EXCL + stale recovery).
// SIGTERMs daemons spawned from a different binary file (detected by mtime).

import { readFileSync, writeFileSync, statSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { HookConfig } from '../../scripts/lib/hook-config.mjs';
import { spawnEnv } from '../../scripts/lib/env.mjs';
import { logError } from '../../scripts/lib/log.mjs';
import { isProcessAlive, acquireLock, releaseLock } from '../../scripts/lib/file-lock.mjs';

export async function run(ctx) {
  const { pluginDir, pluginData, vaultRoot } = ctx;

  const { findBinary: findBinaryShared } = await import('../lib/common.mjs');
  const binary = findBinaryShared();

  const DB_PATH = join(vaultRoot, '.vault-search', 'vault-index.db');
  if (!binary || !existsSync(DB_PATH) || !pluginData) return;

  // Lock lives next to the vault index it protects, not next to the plugin
  // install. Two installations (e.g. real + test sandbox) pointing at the same
  // vault must share one daemon, not spawn one each.
  const lockDir = join(vaultRoot, '.vault-search');
  const pidPath = join(lockDir, 'watch.pid');
  const fingerprintPath = join(lockDir, 'watch.fingerprint');

  // One-shot migration: older builds wrote watch.pid into <plugin-data>/.
  // Any daemon still running off the legacy pidfile must be SIGTERMed or it
  // will coexist with the new per-vault daemon and double-write the index.
  const legacyPidPath = join(pluginData, 'watch.pid');
  const legacyVersionPath = join(pluginData, 'watch.version');
  try {
    const raw = readFileSync(legacyPidPath, 'utf8').trim();
    const pid = parseInt(raw, 10);
    if (Number.isFinite(pid) && isProcessAlive(pid)) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch (err) {
        // SIGTERM can still fail with EPERM (not our process) or ESRCH
        // (process died between liveness check and signal). Either way the
        // daemon is no longer holding the legacy pidfile we care about.
        logError('session-start.watch-daemon.legacyReap', err);
      }
    }
  } catch {
    // No legacy pidfile, nothing to migrate.
  }
  try {
    rmSync(legacyPidPath, { force: true });
    rmSync(legacyVersionPath, { force: true });
  } catch (err) {
    logError('session-start.watch-daemon.legacyRm', err);
  }

  // Identify the binary by its mtime, not by a version string. The Rust crate
  // version (written by the daemon into watch.version) and the npm plugin
  // version drift independently across releases, so comparing them caused a
  // SIGTERM-and-respawn on every SessionStart. The binary file's mtime
  // changes only when the install changes, which is exactly when we want to
  // restart the daemon.
  let currentFingerprint;
  try {
    currentFingerprint = String(statSync(binary.bin).mtimeMs);
  } catch (err) {
    logError('session-start.watch-daemon.fingerprint', err);
    return;
  }

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
    return isProcessAlive(pid) ? { state: 'alive', pid } : { state: 'dead', pid };
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
    let runningFingerprint = '';
    try {
      runningFingerprint = readFileSync(fingerprintPath, 'utf8').trim();
    } catch (err) {
      logError('session-start.watch-daemon.readFingerprint', err);
    }
    if (runningFingerprint === currentFingerprint) {
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
    // acquireLock guards pidPath + '.lock' = watch.pid.lock — same name the old
    // lock used, so stale locks from older installs are recovered, not orphaned.
    let handle = null;
    try {
      handle = acquireLock(pidPath);
    } catch (err) {
      logError('session-start.watch-daemon.acquireLock', err);
      return;
    }
    if (!handle) {
      logError(
        'session-start.watch-daemon.acquireLock',
        new Error('spawn lock busy after retries'),
      );
      return;
    }
    try {
      // Occupied means alive OR writer-in-progress: an empty pidfile is a
      // daemon mid-write of its own pid, not a free slot.
      const post = checkAlive();
      if (post.state === 'alive' || post.state === 'writer-in-progress') return;
      try {
        writeFileSync(fingerprintPath, currentFingerprint);
      } catch (err) {
        logError('session-start.watch-daemon.writeFingerprint', err);
      }
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
    } finally {
      releaseLock(handle);
    }
  }
}
