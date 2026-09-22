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
// adds model/version conditionally). Missing labels are dropped from
// `attributes` rather than stamped as "undefined": schema.mjs's validator
// would reject an attribute value that isn't a real string anyway.
// session_id is deliberately not a label here: these are whole-corpus
// aggregates, and an earlier version stamped the LAST record's session id on
// every total, which read as attribution and was not.
function labelsFor(r) {
  const attributes = {};
  if (r.model !== undefined && r.model !== null) attributes.model = labelOf(r.model);
  if (r.version !== undefined && r.version !== null) attributes.version = labelOf(r.version);
  return attributes;
}

const SUM_FIELDS = [
  'cache_read',
  'cache_creation',
  'uncached_input',
  'output_tokens',
  'session_busts',
];

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

  // Token totals and session_busts sum per label set (model, version), one
  // series each, so attribution is real: the tokens a model consumed are
  // counted under that model, not under whichever model wrote the last line.
  // The label sets are few (the models and plugin versions seen), so the
  // cardinality is bounded.
  const seriesByLabels = new Map();
  const turnHitRates = [];
  const windowHitRates = [];
  const lifetimeHitRates = [];
  let lastCost;

  for (const r of records) {
    const attributes = labelsFor(r);
    const key = JSON.stringify(attributes);
    let series = seriesByLabels.get(key);
    if (!series) {
      series = { attributes, sums: Object.fromEntries(SUM_FIELDS.map((f) => [f, 0])) };
      seriesByLabels.set(key, series);
    }
    for (const field of SUM_FIELDS) {
      if (typeof r[field] === 'number' && Number.isFinite(r[field])) series.sums[field] += r[field];
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

  const metrics = [
    ...[...seriesByLabels.values()].flatMap(({ attributes, sums }) =>
      SUM_FIELDS.map((field) =>
        counter(field, sums[field], { timeUnixMs, startTimeUnixMs, attributes }),
      ),
    ),
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
    // A running total: the latest cumulative figure, under the labels of the
    // record that reported it.
    metrics.push({
      name: `${METRIC_PREFIX}.cache_health.total_cost_usd`,
      type: 'gauge',
      value: lastCost,
      timeUnixMs,
      stream: STREAM,
      attributes: labelsFor(records[records.length - 1]),
    });
  }

  return metrics;
}
