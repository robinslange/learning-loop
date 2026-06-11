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
import { isProcessAlive } from './file-lock.mjs';

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
  lastReflect: (pluginData) => join(DATA_PATHS.markers(pluginData), 'last-reflect'),
  dreamLock: (pluginData) => join(DATA_PATHS.markers(pluginData), 'dream-lock'),
  dreamNudged: (pluginData) => join(DATA_PATHS.markers(pluginData), 'dream-nudged'),
  memorySnapshot: (pluginData, sessionId) =>
    join(
      DATA_PATHS.markers(pluginData),
      sessionId ? `memory-snapshot-${sessionId}` : 'memory-snapshot',
    ),
};

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
