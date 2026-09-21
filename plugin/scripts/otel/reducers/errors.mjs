// scripts/otel/reducers/errors.mjs : T2e, the hook-errors + logs reducer.
//
// See docs/plans/otel-consolidation.md, "Phase 2: aggregators and POST",
// signal mapping: "hook-errors to a counter by module and code", and the
// "Coverage" section's T1i subsection: log.mjs's error sink turns 121
// previously stderr-only failure modes into a durable, exportable stream.
//
// Two streams, two `stream` tags, so otlp.mjs's phase 0 allowlist applies the
// right schema to each:
//   - hook-errors: PLUGIN_DATA/hook-errors-YYYY-MM.jsonl (no subdirectory,
//     the two legacy hand-rolled writers T1i is collapsing).
//   - logs: PLUGIN_DATA/logs/log-YYYY-MM.jsonl (log.mjs's new error sink).
//
// Follows reduce.mjs's whole-corpus contract: read every file for both
// streams, recompute from scratch, return metric records. No watermark, no
// cursor. Either stream's files may be entirely absent (a fresh install with
// no errors yet), and that yields [] for that stream rather than throwing.

import {
  readRecords,
  monthlyFiles,
  countBy,
  histogramFrom,
  LATENCY_BOUNDS_MS,
} from '../reduce.mjs';
import { DATA_PATHS } from '../../lib/paths.mjs';

const HOOK_ERRORS_STREAM = 'hook-errors';
const LOGS_STREAM = 'logs';

function reduceHookErrors(pluginData, timeUnixMs) {
  const files = monthlyFiles(pluginData, 'hook-errors-');
  const records = readRecords(files);

  const latencies = records.map((r) => r.latency_ms).filter((v) => v !== undefined);
  const elapsed = records.map((r) => r.elapsed_ms).filter((v) => v !== undefined);
  // budget_ms is a configured timeout, not a live measurement, but different
  // modules and sources (daemon-socket vs subprocess-fallback) configure
  // different budgets, so a single gauge would overwrite one module's budget
  // with another's on every run. A histogram keeps the whole distribution,
  // which is also what makes it comparable against the latency_ms histogram
  // it is a budget for.
  const budgets = records.map((r) => r.budget_ms).filter((v) => v !== undefined);

  return [
    ...countBy(records, {
      name: 'hook_error_module',
      stream: HOOK_ERRORS_STREAM,
      by: ['module'],
      timeUnixMs,
    }),
    ...countBy(records, {
      name: 'hook_error_code',
      stream: HOOK_ERRORS_STREAM,
      by: ['code'],
      timeUnixMs,
    }),
    ...histogramFrom(latencies, {
      name: 'hook_error_latency_ms',
      stream: HOOK_ERRORS_STREAM,
      bounds: LATENCY_BOUNDS_MS,
      timeUnixMs,
    }),
    ...histogramFrom(elapsed, {
      name: 'hook_error_elapsed_ms',
      stream: HOOK_ERRORS_STREAM,
      bounds: LATENCY_BOUNDS_MS,
      timeUnixMs,
    }),
    ...histogramFrom(budgets, {
      name: 'hook_error_budget_ms',
      stream: HOOK_ERRORS_STREAM,
      bounds: LATENCY_BOUNDS_MS,
      timeUnixMs,
    }),
  ];
}

function reduceLogs(pluginData, timeUnixMs) {
  const dir = DATA_PATHS.logs(pluginData);
  const files = monthlyFiles(dir, 'log-');
  const records = readRecords(files);

  return [
    ...countBy(records, {
      name: 'log_error_scope',
      stream: LOGS_STREAM,
      by: ['scope'],
      timeUnixMs,
    }),
    ...countBy(records, { name: 'log_level', stream: LOGS_STREAM, by: ['level'], timeUnixMs }),
  ];
}

/**
 * Reduce the whole hook-errors and log.mjs sink corpora to metric records.
 * Re-derived from scratch on every call, so running it twice against the same
 * corpus returns identical output.
 *
 * @param {object} opts
 * @param {string} opts.pluginData  CLAUDE_PLUGIN_DATA root
 * @param {number} opts.timeUnixMs
 * @returns {object[]} metric records, stream: 'hook-errors' or 'logs'
 */
export function reduceErrors({ pluginData, timeUnixMs }) {
  return [...reduceHookErrors(pluginData, timeUnixMs), ...reduceLogs(pluginData, timeUnixMs)];
}
