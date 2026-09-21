// scripts/otel/reducers/cache-health.mjs : T2c, the cache-health reducer.
//
// cache-health is the only genuinely metric-shaped stream (plan, "Current
// surface"): every record already carries cache_read/cache_creation/
// uncached_input/output_tokens, three hit-rate ratios, session_busts and
// (only on some records) model/version/total_cost_usd. See
// docs/plans/otel-consolidation.md, Phase 2 "Signal mapping".
//
// Follows reduce.mjs's contract: whole-corpus re-derive, no watermark. Two
// runs over the same files produce byte-identical output.

import { DATA_PATHS } from '../../lib/paths.mjs';
import {
  readRecords,
  monthlyFiles,
  histogramFrom,
  METRIC_PREFIX,
  RATIO_BOUNDS,
  earliestTimestamp,
  labelOf,
} from '../reduce.mjs';

const STREAM = 'cache-health';

// Labels present on some records, absent on others (the statusline plugin
// adds model/version/total_cost_usd conditionally). Missing labels are
// dropped from `attributes` rather than stamped as "undefined": schema.mjs's
// validator would reject an attribute value that isn't a real string anyway.
function labelsFor(r) {
  const attributes = { session_id: labelOf(r.session_id) };
  if (r.model !== undefined && r.model !== null) attributes.model = labelOf(r.model);
  if (r.version !== undefined && r.version !== null) attributes.version = labelOf(r.version);
  return attributes;
}

function counter(name, value, { timeUnixMs, startTimeUnixMs, attributes }) {
  return {
    name: `${METRIC_PREFIX}.cache_health.${name}`,
    type: 'counter',
    value,
    timeUnixMs,
    startTimeUnixMs,
    stream: STREAM,
    attributes,
  };
}

/**
 * Reduce the whole cache-health corpus to metric records.
 * @param {object} opts
 * @param {string} opts.pluginData  PLUGIN_DATA root
 * @param {number} opts.timeUnixMs  export time, stamped on every point
 * @returns {object[]} otlp.mjs-shaped metric records
 */
export function reduceCacheHealth({ pluginData, timeUnixMs }) {
  const files = monthlyFiles(DATA_PATHS.retrieval(pluginData), 'cache-health-');
  const records = readRecords(files);
  if (records.length === 0) return [];

  // Cumulative counters need a stable start time drawn from the corpus
  // itself (the earliest record's ts), not from "now": that is what lets a
  // replayed POST be absorbed by the backend instead of double-counted. See
  // the plan's "Idempotency and the window".
  const startTimeUnixMs = earliestTimestamp(records, timeUnixMs);

  const sums = {
    cache_read: 0,
    cache_creation: 0,
    uncached_input: 0,
    output_tokens: 0,
    session_busts: 0,
  };
  const turnHitRates = [];
  const windowHitRates = [];
  const lifetimeHitRates = [];
  let lastCost;

  for (const r of records) {
    for (const key of Object.keys(sums)) {
      if (typeof r[key] === 'number' && Number.isFinite(r[key])) sums[key] += r[key];
    }
    if (typeof r.turn_hit_rate === 'number') turnHitRates.push(r.turn_hit_rate);
    if (typeof r.window_hit_rate === 'number') windowHitRates.push(r.window_hit_rate);
    if (typeof r.lifetime_hit_rate === 'number') lifetimeHitRates.push(r.lifetime_hit_rate);
    // A running total is more useful as the latest cumulative figure than a
    // per-turn value would be, so the gauge tracks the corpus's last record
    // in file order (readRecords preserves monthlyFiles' sorted order).
    if (typeof r.total_cost_usd === 'number' && Number.isFinite(r.total_cost_usd))
      lastCost = r.total_cost_usd;
  }

  // Token totals and session_busts aggregate the whole corpus into one
  // series per label set. Attribution (model/version/session_id) is real but
  // sparse, so a single global sum with no attributes would lose it; instead
  // sum is taken across ALL records without per-record labels, since a
  // counter cannot carry a per-record attribute set and remain one series.
  // The last record's labels (freshest model/version/session) are stamped on
  // each counter, consistent with the gauge's "latest wins" choice above.
  const lastLabels = labelsFor(records[records.length - 1]);
  const shared = { timeUnixMs, startTimeUnixMs, attributes: lastLabels };

  const metrics = [
    counter('cache_read', sums.cache_read, shared),
    counter('cache_creation', sums.cache_creation, shared),
    counter('uncached_input', sums.uncached_input, shared),
    counter('output_tokens', sums.output_tokens, shared),
    counter('session_busts', sums.session_busts, shared),
    ...histogramFrom(turnHitRates, {
      name: 'cache_health.turn_hit_rate',
      stream: STREAM,
      bounds: RATIO_BOUNDS,
      timeUnixMs,
      startTimeUnixMs,
    }),
    ...histogramFrom(windowHitRates, {
      name: 'cache_health.window_hit_rate',
      stream: STREAM,
      bounds: RATIO_BOUNDS,
      timeUnixMs,
      startTimeUnixMs,
    }),
    ...histogramFrom(lifetimeHitRates, {
      name: 'cache_health.lifetime_hit_rate',
      stream: STREAM,
      bounds: RATIO_BOUNDS,
      timeUnixMs,
      startTimeUnixMs,
    }),
  ];

  if (lastCost !== undefined) {
    metrics.push({
      name: `${METRIC_PREFIX}.cache_health.total_cost_usd`,
      type: 'gauge',
      value: lastCost,
      timeUnixMs,
      stream: STREAM,
      attributes: lastLabels,
    });
  }

  return metrics;
}
