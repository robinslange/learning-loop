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
 * EPERM means the process exists but is owned by another user — still alive.
 * @param {number} pid
 * @returns {boolean}
 */
function isProcessAlive(pid) {
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
 * @param {string} lockPath
 * @param {number} staleMs
 * @returns {boolean} true if the lock was removed and the caller may retry.
 */
function tryRemoveIfStale(lockPath, staleMs) {
  try {
    const raw = readFileSync(lockPath, 'utf8').trim();
    const pid = parseInt(raw, 10);
    if (Number.isFinite(pid) && !isProcessAlive(pid)) {
      unlinkSync(lockPath);
      return true;
    }
    // PID is alive — do not remove.
    return false;
  } catch {
    // Lockfile vanished mid-read or contains an unreadable PID.
    // Try mtime-based staleness as a backstop.
    try {
      const { mtimeMs } = statSync(lockPath);
      if (Date.now() - mtimeMs > staleMs) {
        unlinkSync(lockPath);
        return true;
      }
      // eslint-disable-next-line learning-loop/no-empty-catch
    } catch {}
    return false;
  }
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

  for (let i = 0; i < retries; i++) {
    try {
      const fd = openSync(
        lockPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      );
      writeFileSync(fd, String(process.pid));
      return { lockPath, fd };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (tryRemoveIfStale(lockPath, staleMs)) continue;
      if (i < retries - 1) syncSleep(delayMs);
    }
  }
  return null;
}

/**
 * Release a lock handle returned by acquireLock.
 * Safe to call multiple times; idempotent on already-closed handles.
 *
 * @param {{ lockPath: string, fd: number } | null | undefined} handle
 * @returns {boolean} true if a lock was present and released.
 */
export function releaseLock(handle) {
  if (!handle || handle.fd === undefined) return false;
  try {
    closeSync(handle.fd);
    // eslint-disable-next-line learning-loop/no-empty-catch
  } catch {}
  try {
    unlinkSync(handle.lockPath);
    // eslint-disable-next-line learning-loop/no-empty-catch
  } catch {}
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
