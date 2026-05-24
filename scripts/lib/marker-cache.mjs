// scripts/lib/marker-cache.mjs
// Cache for detached subprocess results. Workers write; the next session-start
// reads. Absent or stale entries return null — caller treats that as "no data".
//
// MARKER_PATHS is the single source of truth: both the hook (reader) and the
// worker (writer) resolve their path through the same function so the two
// sides cannot drift.

import { readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logError } from './log.mjs';
import { DATA_PATHS } from './paths.mjs';

// 25 hours: ensures at least one session per day refreshes, even on weekly cadence.
export const MARKER_TTL_MS = 25 * 60 * 60 * 1000;

// Canonical marker paths. Hook and worker both call these — never construct
// the path inline. Add a new marker by adding a new entry here. The parent
// directory comes from DATA_PATHS.sessionStartCache so a future rename of
// session-start-cache/ requires changing exactly one line.
export const MARKER_PATHS = {
  intentions: (pluginData) => join(DATA_PATHS.sessionStartCache(pluginData), 'intentions.json'),
  dreamGate: (pluginData) => join(DATA_PATHS.sessionStartCache(pluginData), 'dream-gate.json'),
};

export function readMarker(path) {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  if (Date.now() - stat.mtimeMs > MARKER_TTL_MS) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    logError('marker-cache.readMarker', err);
    return null;
  }
}

// Note: writeMarker is typically called from a detached subprocess. If the
// write fails, logError emits to stderr — but a detached child's stderr is
// not attached to anything observable. Errors are effectively silent in
// production. This is acceptable because (a) the worst case is a stale
// marker on the next session-start, and (b) the next worker run will
// retry. If you ever need observable write failures, consider setting
// process.exitCode and inspecting it from the parent.
export function writeMarker(path, value) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value));
  } catch (err) {
    logError('marker-cache.writeMarker', err);
  }
}
