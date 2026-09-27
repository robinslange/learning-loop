import { closeSync, mkdirSync, openSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { solenoid, LimitExceeded, SolenoidUnavailable } from '../../vendor/solenoid/solenoid.mjs';
import { fileStore } from '../../vendor/solenoid/node.mjs';

// Per-session fetch budget under PLUGIN_DATA/fetch-budget/<sessionId>/: one
// file per granted fetch, named 1..budget. A claim is an exclusive create of
// the first free slot, so of N concurrent gateway processes exactly
// min(N, budget) win, and a refused claim writes nothing.
//
// Callers own the no-session case. Neither function throws. A claim that
// cannot reach its directory is granted: nothing has been enforced yet, so
// there is nothing to protect by refusing. Past that point we are inside the
// enforcement itself, and a slot create that fails for any reason but EEXIST
// leaves no record of the grant. The budget is a cap, not a best-effort
// counter: refusing this one fetch costs a retry, while granting it unrecorded
// lets the cap be exceeded.

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
      if (err.code !== 'EEXIST') return false;
    }
  }
  return false;
}

export function budgetScopeSegment(sessionId) {
  if (!sessionId || sessionId === 'unknown') return null;
  const seg = sessionId
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .slice(0, 64);
  return seg === '' || /^[.]+$/.test(seg) ? null : seg;
}

// Solenoid-backed budget: the developer sets the cap once, outside the agent
//   solenoid limit learning-loop/research fetches=10 --per child --on-outage open
// and every session spends at learning-loop/research/<session>, a child scope
// under that limit. This is a yes/no gate (per the SDK's documented pattern):
// it refuses on LimitExceeded for the fetches unit and on SolenoidUnavailable,
// and rethrows anything else (an unrelated limit, a bad key, ...).
//
// fileStore() persists the outage mode across processes on this machine, the
// same one-process-per-fetch pattern readCount/claimFetch above are built for.
// With a known pluginData, the cache lives under it rather than the shared
// machine-wide ~/.cache/solenoid — keeps one caller's outage state (tests,
// another plugin data dir) from leaking into another's.
const SOLENOID_SCOPE_ROOT = 'learning-loop/research';

export function buildSolenoidStore(sessionId, pluginData) {
  const seg = budgetScopeSegment(sessionId);
  if (!seg) return null;
  const scope = `${SOLENOID_SCOPE_ROOT}/${seg}`;
  const sol = solenoid({
    store: pluginData ? fileStore(join(pluginData, 'solenoid')) : fileStore(),
  });
  return {
    async tryBump() {
      try {
        await sol.spend(scope, { fetches: 1 });
        return true;
      } catch (e) {
        if (e instanceof LimitExceeded && e.unit === 'fetches') return false;
        if (e instanceof SolenoidUnavailable) return false;
        throw e;
      }
    },
  };
}
