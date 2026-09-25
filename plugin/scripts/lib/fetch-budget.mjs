import { closeSync, mkdirSync, openSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Per-session fetch budget under PLUGIN_DATA/fetch-budget/<sessionId>/: one
// file per granted fetch, named 1..budget. A claim is an exclusive create of
// the first free slot, so of N concurrent gateway processes exactly
// min(N, budget) win, and a refused claim writes nothing.
//
// Callers own the no-session case. Neither function throws: a counter failure
// must not break fetch, so a claim that cannot reach its directory is granted.

function slotDir(sessionId, pluginData) {
  return join(pluginData, 'fetch-budget', sessionId);
}

export function readCount(sessionId, pluginData) {
  try {
    return readdirSync(slotDir(sessionId, pluginData)).length;
  } catch {
    return 0;
  }
}

export function claimFetch(sessionId, pluginData, budget) {
  const dir = slotDir(sessionId, pluginData);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return true;
  }
  for (let slot = 1; slot <= budget; slot++) {
    try {
      closeSync(openSync(join(dir, String(slot)), 'wx'));
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') return true;
    }
  }
  return false;
}
