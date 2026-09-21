#!/usr/bin/env node
// scripts/otel/run-export.mjs : T2g, the top-level runner. The entry point
// the detached worker (T2h) invokes: load every reducer, collect metric
// records under one shared timestamp, serialize and POST. See
// docs/plans/otel-consolidation.md, "Phase 2: aggregators and POST".
//
// Reducer siblings are loaded via dynamic import, guarded, rather than a
// static import list. This is deliberate during phase 2 rollout: five other
// reducers are landing concurrently in sibling files, and a reducer that
// does not exist yet (or fails to import) must be skipped and logged, not
// crash the whole run.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isMainModule } from '../lib/is-main.mjs';
import { getPluginData } from '../lib/config.mjs';
import { logError } from '../lib/log.mjs';
import { buildOtlpPayload } from './otlp.mjs';
import { exportMetrics } from './export.mjs';

const REDUCER_DIR = join(import.meta.dirname, 'reducers');

// name -> exported reduce function, e.g. 'provenance' -> reduceProvenance.
export const REDUCERS = [
  'provenance',
  'cache-health',
  'retrieval',
  'errors',
  'librarian',
  'dream-eval',
  'session',
];

function exportNameFor(reducerName) {
  const pascal = reducerName.replace(/(^|-)([a-z])/g, (_, __, c) => c.toUpperCase());
  return `reduce${pascal}`;
}

/**
 * Load every reducer that exists, tolerating a missing or broken sibling.
 * @param {string[]} reducers  names to load, defaults to REDUCERS
 * @returns {Promise<{loaded: object[], skipped: string[]}>}
 */
async function loadReducers(reducers) {
  const loaded = [];
  const skipped = [];
  for (const entry of reducers) {
    if (typeof entry === 'object') {
      loaded.push(entry);
      continue;
    }
    const name = entry;
    const file = join(REDUCER_DIR, `${name}.mjs`);
    if (!existsSync(file)) {
      skipped.push(name);
      continue;
    }
    try {
      const mod = await import(`./reducers/${name}.mjs`);
      const fn = mod[exportNameFor(name)];
      if (typeof fn !== 'function') throw new Error(`no ${exportNameFor(name)} export`);
      loaded.push({ name, fn });
    } catch (err) {
      logError('otel.runExport.missingReducer', err, { name });
      skipped.push(name);
    }
  }
  return { loaded, skipped };
}

/**
 * Run every available reducer against `pluginData`, collect their records
 * under one shared timestamp, and export the result. Never throws.
 *
 * @param {object} opts
 * @param {string} [opts.pluginData]  defaults to getPluginData()
 * @param {boolean} [opts.dryRun]     print the payload instead of POSTing
 * @param {boolean} [opts.enabled]    test seam, passed through to exportMetrics
 * @param {string} [opts.endpoint]    test seam, passed through to exportMetrics
 * @param {(string|{name: string, fn: Function})[]} [opts.reducers]  test seam, defaults to REDUCERS
 * @returns {Promise<object>} structured result: {ok, sent, reducersLoaded, reducersSkipped, payload?, error?}
 */
export async function runExport(opts = {}) {
  const pluginData = opts.pluginData ?? getPluginData();
  const dryRun = Boolean(opts.dryRun);
  const timeUnixMs = Date.now();

  const { loaded, skipped } = await loadReducers(opts.reducers ?? REDUCERS);
  const metrics = [];
  const failed = [];
  for (const { name, fn } of loaded) {
    try {
      metrics.push(...fn({ pluginData, timeUnixMs }));
    } catch (err) {
      logError('otel.runExport.reducerFailed', err, { name });
      failed.push(name);
    }
  }

  // exportMetrics is a no-op before it even looks at dryRun when disabled or
  // endpointless, since that is the right default for a real send. --dry-run
  // is explicitly the exception (plan: "the honest audit of the free-text
  // rule"): it must show the payload even with export off or no endpoint
  // configured yet, so it can be used to inspect *before* enabling.
  const exportOpts = { dryRun };
  if ('enabled' in opts) exportOpts.enabled = opts.enabled;
  if ('endpoint' in opts) exportOpts.endpoint = opts.endpoint;
  if (dryRun) {
    exportOpts.enabled = true;
    if (!exportOpts.endpoint) exportOpts.endpoint = 'http://dry-run.invalid';
  }
  const result = await exportMetrics(metrics, exportOpts);

  // The healthy streams still ship, but a run missing a reducer's output is
  // not a success: reported ok, the worker would stamp the marker and /doctor
  // would show healthy delivery while one signal was silently absent from
  // every export until someone noticed.
  if (failed.length > 0 && result.ok) {
    result.ok = false;
    result.error = `reducer(s) failed: ${failed.join(', ')}`;
  }

  return {
    ...result,
    reducersLoaded: loaded.map((r) => r.name),
    reducersSkipped: skipped,
    reducersFailed: failed,
  };
}

if (isMainModule(import.meta.url)) {
  const dryRun = process.argv.includes('--dry-run');
  runExport({ dryRun }).then((result) => {
    if (!result.ok)
      logError('otel.runExport.failed', new Error(result.error || 'export failed'), { result });
  });
}
