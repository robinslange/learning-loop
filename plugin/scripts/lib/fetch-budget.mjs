import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

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

export function bumpCount(sessionId, pluginData) {
  if (!pluginData || !sessionId || sessionId === 'unknown') return;
  const dir = join(pluginData, 'fetch-budget');
  try {
    mkdirSync(dir, { recursive: true });
    const file = budgetFile(sessionId, pluginData);
    const current = readCount(sessionId, pluginData);
    writeFileSync(file, String(current + 1), 'utf8');
  } catch {
    // never throw — a write failure must not break fetch
  }
}
