import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { withLock } from './file-lock.mjs';

// Per-session fetch budget counter backed by a single-integer file under
// PLUGIN_DATA/fetch-budget/<sessionId>.count. Survives process boundaries
// so the budget is real across the one-process-per-URL gateway invocation pattern.
//
// Graceful degradation: if pluginData is null OR sessionId is empty/unknown,
// all operations are no-ops and readCount returns 0. A missing data dir never
// throws — it must not break fetch in edge environments.

function budgetFile(sessionId, pluginData) {
  return join(pluginData, 'fetch-budget', `${sessionId}.count`);
}

export function readCount(sessionId, pluginData) {
  if (!pluginData || !sessionId || sessionId === 'unknown') return 0;
  const file = budgetFile(sessionId, pluginData);
  if (!existsSync(file)) return 0;
  try {
    const n = parseInt(readFileSync(file, 'utf8').trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

// Reserve one fetch atomically across processes. Reading the count and writing
// count + 1 separately let parallel research subagents fetch past the budget.
export function tryBump(sessionId, pluginData, budget) {
  if (!pluginData || !sessionId || sessionId === 'unknown') return true;
  const file = budgetFile(sessionId, pluginData);
  try {
    mkdirSync(join(pluginData, 'fetch-budget'), { recursive: true });
    return withLock(file, { retries: 400, retryDelayMs: 5 }, () => {
      const n = readCount(sessionId, pluginData);
      if (n >= budget) return false;
      writeFileSync(file, String(n + 1), 'utf8');
      return true;
    });
  } catch {
    return true;
  }
}

export function budgetScopeSegment(sessionId) {
  if (!sessionId || sessionId === 'unknown') return null;
  const seg = sessionId
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .slice(0, 64);
  return seg === '' || /^[.]+$/.test(seg) ? null : seg;
}
