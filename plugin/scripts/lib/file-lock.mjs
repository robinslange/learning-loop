// scripts/lib/file-lock.mjs : O_EXCL-based advisory file locks with stale recovery.
//
// Wraps the openSync(O_CREAT|O_EXCL|O_WRONLY) + PID-write pattern already in
// hooks/lib/snapshot.mjs, scripts/lib/edges.mjs, and
// scripts/lib/sources/citation-index.mjs. O_EXCL is the only POSIX primitive
// that gives a syscall-atomic "create if and only if not present"; flag:'wx' on
// writeFileSync is two syscalls under the hood and races with concurrent writers.
//
// Stale-lock detection: if openSync fails with EEXIST, we read the existing
// lockfile's PID and probe with process.kill(pid, 0). If the owner is dead, we
// unlink the lock and retry. We deliberately avoid mtime-based staleness as the
// primary path: PID probe is correct on every Unix and on Windows (where
// kill(0) returns EPERM for a live process, which we treat as alive).
//
// The three original lock sites (snapshot.mjs, edges.mjs, citation-index.mjs)
// are NOT touched in phase 0; consumers migrate in phase 1.

import {
  openSync,
  closeSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  statSync,
  constants as fsConstants,
} from 'node:fs';
import { logError } from './log.mjs';

const DEFAULT_RETRIES = 5;
const DEFAULT_DELAY_MS = 20;
// Stale-by-mtime backstop: if a lockfile is older than this and the PID is
// unreadable, treat it as abandoned. Lock holders should never hold for more
// than a few hundred ms; one minute is a deliberately conservative floor.
const DEFAULT_STALE_MS = 60_000;

// SharedArrayBuffer-backed sync sleep — same pattern as hooks/lib/snapshot.mjs.
// Atomics.wait suspends the thread without spinning; works in any Node context
// that has SharedArrayBuffer available (Node 22+ always does).
const _sleepBuf = new Int32Array(new SharedArrayBuffer(4));
function syncSleep(ms) {
  if (ms > 0) Atomics.wait(_sleepBuf, 0, 0, ms);
}

/**
 * Returns true if the given PID corresponds to a live process.
 * EPERM means the process exists but is owned by another user — still alive
 * (matches POSIX semantics; on Windows, kill(pid, 0) returns EPERM for a
 * live process owned by SYSTEM, so the EPERM-means-alive rule is correct
 * cross-platform).
 *
 * Exported so other liveness probes (watch.mjs, health-check.mjs,
 * watch-daemon.mjs) can share the same EPERM-means-alive contract instead
 * of hand-rolling their own try/catch around process.kill(pid, 0).
 *
 * @param {number} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * Attempts to remove a lockfile if its recorded PID is no longer alive.
 * Falls back to mtime-based staleness when the PID is unreadable.
 *
 * @param {string} lockPath
 * @param {number} staleMs
 * @param {{ statFn?: (path: string) => { mtimeMs: number } }} [deps]
 *   Optional dependency injection — defaults to fs.statSync. Tests pass a
 *   stub to exercise the mtime-fallback failure path without engineering
 *   a filesystem race between readFileSync and statSync.
 * @returns {boolean} true if the lock was removed and the caller may retry.
 */
export function tryRemoveIfStale(lockPath, staleMs, { statFn = statSync } = {}) {
  // mtime backstop: used whenever the PID can't prove the owner is alive —
  // whether the read threw, or it succeeded but held an empty/garbage PID.
  // An unreadable-but-fresh lock is left alone; only an old one is reclaimed.
  const removeIfMtimeStale = () => {
    try {
      const { mtimeMs } = statFn(lockPath);
      if (Date.now() - mtimeMs > staleMs) {
        unlinkSync(lockPath);
        return true;
      }
    } catch (err) {
      // ENOENT means the lockfile vanished (a concurrent recovery). Expected
      // race, not a failure. Anything else is genuinely unusual — worth
      // surfacing.
      if (err.code !== 'ENOENT') logError('file-lock.mtimeFallback', err, { lockPath });
    }
    return false;
  };

  let raw;
  try {
    raw = readFileSync(lockPath, 'utf8').trim();
  } catch {
    // Read failed (vanished mid-read, permissions). Let mtime decide.
    return removeIfMtimeStale();
  }

  const pid = parseInt(raw, 10);
  if (Number.isFinite(pid) && pid > 0) {
    if (!isProcessAlive(pid)) {
      unlinkSync(lockPath);
      return true;
    }
    // Owner is alive — do not remove.
    return false;
  }
  // Empty or non-numeric PID: the owner is unknowable, so fall back to mtime
  // instead of assuming the lock is live (which would wedge it forever).
  return removeIfMtimeStale();
}

/**
 * Acquire an O_EXCL advisory lock on `<path>.lock`.
 *
 * @param {string} path   The file whose updates this lock guards.
 * @param {{
 *   retries?: number,
 *   retryDelayMs?: number,
 *   staleMs?: number,
 * }} [opts]
 * @returns {{ lockPath: string, fd: number } | null}
 *   A handle on success; null if the lock cannot be acquired after all retries.
 */
export function acquireLock(path, opts = {}) {
  const lockPath = path + '.lock';
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const delayMs = opts.retryDelayMs ?? DEFAULT_DELAY_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const writeFn = opts.writeFn ?? writeFileSync;

  for (let i = 0; i < retries; i++) {
    // Each iteration may open once, and — if it displaces a stale lock — open
    // again immediately, so a stale lock cleared on the final iteration is
    // still re-acquired rather than falling through to null.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return openLockFile(lockPath, writeFn);
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        // Only retry within this iteration if we actually removed a stale lock.
        if (!tryRemoveIfStale(lockPath, staleMs)) break;
      }
    }
    if (i < retries - 1) syncSleep(delayMs);
  }
  return null;
}

// Atomically create the lockfile and record the owner PID. If the PID write
// fails after the file is created, close the fd and unlink the empty lockfile
// so a transient write error (ENOSPC/EIO/NFS) doesn't leak an fd or orphan an
// empty lock that mtime-recovery would then have to time out.
export function openLockFile(lockPath, writeFn = writeFileSync) {
  const fd = openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY);
  try {
    writeFn(fd, String(process.pid));
  } catch (err) {
    try {
      closeSync(fd);
    } catch {
      // fd already gone; nothing to clean up.
    }
    try {
      unlinkSync(lockPath);
    } catch {
      // lockfile already gone; nothing to clean up.
    }
    throw err;
  }
  return { lockPath, fd };
}

/**
 * Release a lock handle returned by acquireLock.
 * Safe to call multiple times; idempotent on already-closed handles.
 *
 * @param {{ lockPath: string, fd: number } | null | undefined} handle
 * @returns {boolean} true if a lock was present and released.
 */
export function releaseLock(handle, { closeFn = closeSync, unlinkFn = unlinkSync } = {}) {
  // Both fields are required. acquireLock always returns them together, but a
  // hand-constructed handle missing lockPath would crash unlinkFn(undefined)
  // with TypeError and emit a logError noisy with lockPath: undefined.
  if (!handle || handle.fd === undefined || !handle.lockPath) return false;
  try {
    closeFn(handle.fd);
  } catch (err) {
    // EBADF is the expected harmless case: release was called twice and the
    // fd is already gone. Anything else (EIO on NFS yank, etc.) leaks the fd
    // until process exit — worth surfacing so it can be diagnosed.
    if (err.code !== 'EBADF')
      logError('file-lock.releaseLock.close', err, { lockPath: handle.lockPath });
  }
  try {
    unlinkFn(handle.lockPath);
  } catch (err) {
    // ENOENT means another process (stale-lock recovery in tryRemoveIfStale)
    // already cleaned up — expected race. Anything else (EACCES, EBUSY on
    // Windows when another handle is still open, EPERM, EROFS) means the
    // lockfile *leaked*, and the next acquirer will spin for staleMs (60s)
    // before recovering. That's the exact silent-failure shape Phase 3 set
    // out to surface.
    if (err.code !== 'ENOENT')
      logError('file-lock.releaseLock.unlink', err, { lockPath: handle.lockPath });
  }
  return true;
}

/**
 * Run `fn` inside a synchronous lock-protected critical section.
 * Releases the lock after `fn` returns or throws.
 *
 * @template T
 * @param {string} path
 * @param {{
 *   retries?: number,
 *   retryDelayMs?: number,
 *   staleMs?: number,
 * }} opts
 * @param {() => T} fn
 * @returns {T}
 * @throws {Error} with code `'ELOCK_TIMEOUT'` if the lock cannot be acquired.
 */
export function withLock(path, opts, fn) {
  const handle = acquireLock(path, opts);
  if (!handle) {
    const e = new Error(`file-lock: could not acquire ${path}.lock`);
    e.code = 'ELOCK_TIMEOUT';
    throw e;
  }
  try {
    return fn();
  } finally {
    releaseLock(handle);
  }
}
