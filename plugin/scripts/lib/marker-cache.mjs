// scripts/lib/marker-cache.mjs
// Cache for detached subprocess results. Workers write; the next session-start
// reads. Absent or stale entries return null — caller treats that as "no data".
//
// MARKER_PATHS is the single source of truth: hook, worker, AND skill (via
// scripts/marker.mjs) all resolve their path through these functions so the
// sides cannot drift.

import { readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logError } from './log.mjs';
import { pluginDataExists } from './config.mjs';
import { DATA_PATHS } from './paths.mjs';
import { HookConfig } from './hook-config.mjs';
import { isProcessAlive, withLock } from './file-lock.mjs';

// 25 hours: ensures at least one session per day refreshes, even on weekly cadence.
export const MARKER_TTL_MS = 25 * 60 * 60 * 1000;

// Canonical marker paths. Hook and worker both call these — never construct
// the path inline. Add a new marker by adding a new entry here.
export const MARKER_PATHS = {
  intentions: (pluginData) => join(DATA_PATHS.sessionStartCache(pluginData), 'intentions.json'),
  dreamGate: (pluginData) => join(DATA_PATHS.sessionStartCache(pluginData), 'dream-gate.json'),
  // last-dream stays under retrieval/ — existing installs already carry the
  // timestamp there (dream-gate's first-run write); moving it would reset
  // every install's 24h dream clock.
  lastDream: (pluginData) => join(DATA_PATHS.retrieval(pluginData), 'last-dream'),
  // One-shot edges-backfill marker. Lives under retrieval/ (not markers/)
  // because the markers/ TTL sweep would reap it and re-trigger a full-vault
  // backfill every 7 days.
  edgesBackfilled: (pluginData) => join(DATA_PATHS.retrieval(pluginData), 'edges-backfilled'),
  lastReflect: (pluginData) => join(DATA_PATHS.markers(pluginData), 'last-reflect'),
  dreamLock: (pluginData) => join(DATA_PATHS.markers(pluginData), 'dream-lock'),
  dreamNudged: (pluginData) => join(DATA_PATHS.markers(pluginData), 'dream-nudged'),
  // Session-scoped log of memory files THIS session wrote (post-tool appends
  // on each Write/Edit into the auto-memory dir). stop-nudge counts this,
  // intersected with files still on disk — never a diff of the shared dir,
  // which conflated concurrent sessions' writes and blamed one session for
  // another's files.
  memoryWrites: (pluginData, sessionId) =>
    join(
      DATA_PATHS.markers(pluginData),
      sessionId ? `memory-writes-${sessionId}` : 'memory-writes',
    ),
  // Timestamp of the last stale-marker TTL sweep. Gates the sweep to once a
  // day: the read side already filters stale entries by mtime, so deferring
  // the rm pass is behavior-preserving and saves a per-session stat-walk.
  lastSweep: (pluginData) => join(DATA_PATHS.markers(pluginData), 'last-sweep'),
};

// Append a basename to the session-scoped memory-writes log, de-duplicated.
// Fire-and-forget: a failed read or write — or a lock that can't be acquired
// — costs at most one uncounted file in the dream nudge, never a thrown
// error on the PostToolUse hot path. The read-modify-write runs under a lock
// because two sessions' PostToolUse hooks can interleave (read, read, write,
// write) and lose one session's basename otherwise.
export function appendMemoryWrite(pluginData, sessionId, basename) {
  const path = MARKER_PATHS.memoryWrites(pluginData, sessionId);
  try {
    // The lock file lives alongside the marker (`<path>.lock`) and O_EXCL
    // cannot create it if the parent dir doesn't exist yet — unlike
    // writeMarker's own mkdir, this one has to happen before the lock is
    // even acquired.
    mkdirSync(dirname(path), { recursive: true });
    // Lock-wait budget (~5s): the critical section is a whole-file
    // read-modify-write, and when several sessions' PostToolUse hooks contend
    // on one machine the holder's own syscalls can be starved well past a short
    // budget. A loser that exhausts its budget drops its write, which is
    // exactly the lost update this lock exists to prevent, so the budget must
    // outlast a starved holder. The previous ~780ms did not: it was under the
    // stale-lock reclaim threshold by two orders of magnitude, so a holder
    // merely descheduled on a loaded CI runner outlived it.
    withLock(path, { retries: 250, retryDelayMs: 20 }, () => {
      const existing = readMarker(path, { ttlMs: Infinity });
      const set = new Set(Array.isArray(existing) ? existing : []);
      if (set.has(basename)) return;
      set.add(basename);
      writeMarker(path, [...set]);
    });
  } catch (err) {
    // Never throw: every caller is a fire-and-forget hook. But a timeout means
    // this session's write was LOST, so it must not vanish silently the way it
    // used to — the log line is the only evidence the marker undercounts.
    if (err.code === 'ELOCK_TIMEOUT') {
      logError('marker-cache.appendMemoryWrite', err, { path, basename, lost: true });
      return;
    }
    logError('marker-cache.appendMemoryWrite', err);
  }
}

export function readMarker(path, { ttlMs = MARKER_TTL_MS } = {}) {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  if (Date.now() - stat.mtimeMs > ttlMs) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    logError('marker-cache.readMarker', err);
    return null;
  }
}

// Dream-lock staleness predicate (M5). Held iff the recorded pid is alive,
// or the lock file is younger than DREAM_LOCK_STALE_SECS. Legacy lock
// content (bare pid digits from the old skill one-liner) parses as a JSON
// number; new content is { pid, ts }. Unreadable content falls through to
// the age check alone.
export function dreamLockHeld(path, { staleMs = HookConfig.DREAM_LOCK_STALE_SECS * 1000 } = {}) {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return false;
  }
  let pid = null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    pid = typeof parsed === 'number' ? parsed : (parsed?.pid ?? null);
  } catch {
    // Content unreadable — the age check below decides.
  }
  if (pid != null && isProcessAlive(pid)) return true;
  return Date.now() - stat.mtimeMs < staleMs;
}

// Returns true iff the marker was persisted. writeMarker is typically
// called from a detached subprocess where logError's stderr is not attached
// to anything observable — callers that must not proceed on an unpersisted
// marker (e.g. stop-nudge's once-guard) check the return value instead.
// Fire-and-forget callers may ignore it: the worst case is a stale marker
// on the next session-start, and the next worker run retries.
export function writeMarker(path, value) {
  if (!pluginDataExists()) return false;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value));
    return true;
  } catch (err) {
    logError('marker-cache.writeMarker', err);
    return false;
  }
}
