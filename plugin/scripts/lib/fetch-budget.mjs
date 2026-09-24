import { appendFileSync, statSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Per-session fetch budget counter under PLUGIN_DATA/fetch-budget/<sessionId>.claims.
// Each fetch appends one byte with O_APPEND, so the count is the file size: the
// kernel serialises appends, which makes a bump from one of many concurrent
// gateway processes a claim that can never be lost or reset by another.
//
// Callers own the no-session case; both functions assume a real session and
// plugin data dir. Neither throws: a counter failure must not break fetch.

function budgetFile(sessionId, pluginData) {
  return join(pluginData, 'fetch-budget', `${sessionId}.claims`);
}

export function readCount(sessionId, pluginData) {
  try {
    return statSync(budgetFile(sessionId, pluginData)).size;
  } catch {
    return 0;
  }
}

export function bumpCount(sessionId, pluginData) {
  const file = budgetFile(sessionId, pluginData);
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, '.');
    return statSync(file).size;
  } catch {
    return 0;
  }
}
