// scripts/otel/reduce.mjs : shared scaffolding for the per-stream reducers.
//
// Every reducer follows the same contract, which is the property that makes
// the export idempotent: read the WHOLE corpus for its stream, recompute
// totals from scratch, and return metric records. No watermark, no cursor, no
// incremental state. Running a reducer twice produces identical output.
//
// That is `provenance-consolidate.mjs`'s existing property, and it is cheap
// enough to keep: the full corpus across every stream and month is roughly
// 15MB / 32k lines, read in about 51ms. A watermark would buy nothing and
// would reintroduce the double-counting hazard incremental appends have.
//
// Reducers return records in otlp.mjs's input shape:
//   counter:   {name, type:'counter', value, timeUnixMs, stream, attributes?, startTimeUnixMs?}
//   gauge:     {name, type:'gauge', value, timeUnixMs, stream, attributes?}
//   histogram: {name, type:'histogram', count, sum, bucketCounts, explicitBounds,
//               timeUnixMs, stream, attributes?}
//
// `stream` is mandatory on every record: it is what makes otlp.mjs run the
// phase 0 allowlist over the attributes, so a reducer that stamps a free-text
// attribute fails closed instead of shipping it.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logError } from '../lib/log.mjs';

// Metric names share one prefix so a dashboard can select the whole plugin.
export const METRIC_PREFIX = 'll';

/**
 * Read every JSONL record from the files a reducer names, skipping malformed
 * lines rather than failing the whole run. A stream whose files do not exist
 * yields an empty array: the librarian is optional, dream-eval only exists
 * once dream mode has fired, and a reducer must no-op cleanly in both cases.
 *
 * @param {string[]} files  absolute paths
 * @returns {object[]}
 */
export function readRecords(files) {
  const out = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    let text;
    try {
      text = readFileSync(file, 'utf-8');
    } catch (err) {
      logError('otel.reduce.read', err, { file });
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
        // eslint-disable-next-line learning-loop/no-empty-catch -- a truncated last line is normal for a file being appended to while we read it; skipping one record is correct and logging every one would be noise.
      } catch {
        /* skip malformed line */
      }
    }
  }
  return out;
}

/**
 * List monthly-sharded files in `dir` matching `prefix`, e.g. events-2026-09.
 * Returns absolute paths, empty when the directory is absent.
 *
 * @param {string} dir
 * @param {string} prefix
 * @returns {string[]}
 */
export function monthlyFiles(dir, prefix) {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith('.jsonl'))
      .sort()
      .map((f) => join(dir, f));
  } catch (err) {
    logError('otel.reduce.list', err, { dir, prefix });
    return [];
  }
}

/**
 * Tally records into counter metrics, one per distinct combination of the
 * named attribute values. Records missing any named attribute are skipped, so
 * a partially-shaped historical record cannot invent a bucket labelled
 * undefined.
 *
 * @param {object[]} records
 * @param {object} opts
 * @param {string} opts.name        metric name, without METRIC_PREFIX
 * @param {string} opts.stream      phase 0 stream key
 * @param {string[]} opts.by        attribute field names to group by
 * @param {number} opts.timeUnixMs
 * @param {number} opts.startTimeUnixMs  when the series began, from the corpus
 *   itself (the earliest record's ts), NOT from this run. A cumulative counter
 *   whose start moves every export looks like a brand-new counter each time,
 *   which breaks rate() at every boundary and defeats the whole point of
 *   re-deriving totals. Required for that reason.
 * @returns {object[]} counter records
 */
export function countBy(records, { name, stream, by, timeUnixMs, startTimeUnixMs }) {
  const buckets = new Map();
  for (const r of records) {
    if (by.some((f) => r[f] === undefined || r[f] === null)) continue;
    const attributes = {};
    for (const f of by) attributes[f] = String(r[f]);
    const key = JSON.stringify(attributes);
    const prev = buckets.get(key);
    if (prev) prev.value += 1;
    else buckets.set(key, { attributes, value: 1 });
  }
  return [...buckets.values()].map(({ attributes, value }) => ({
    name: `${METRIC_PREFIX}.${name}`,
    type: 'counter',
    value,
    timeUnixMs,
    startTimeUnixMs: startTimeUnixMs ?? timeUnixMs,
    stream,
    attributes,
  }));
}

/**
 * The earliest timestamp in a corpus, for use as a cumulative counter's stable
 * start. Falls back to `fallbackMs` when no record carries a parseable time
 * (dream-eval has no `ts` at all), so a series still gets a fixed start rather
 * than one that moves per run.
 *
 * @param {object[]} records
 * @param {number} fallbackMs
 * @param {string} [field]  timestamp field name, default 'ts'
 * @returns {number}
 */
export function earliestTimestamp(records, fallbackMs, field = 'ts') {
  let min = Infinity;
  for (const r of records) {
    const t = Date.parse(r[field]);
    if (Number.isFinite(t) && t < min) min = t;
  }
  return Number.isFinite(min) ? min : fallbackMs;
}

// Bucket bounds for millisecond latencies. Chosen to straddle the budgets the
// hooks actually run against: the 60ms post-tool target, the 300-500ms hook
// budgets, and the 2500ms daemon socket wait.
export const LATENCY_BOUNDS_MS = [10, 50, 100, 250, 500, 1000, 2500, 5000];

// Bucket bounds for a 0..1 ratio, e.g. a cache hit rate.
export const RATIO_BOUNDS = [0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99];

/**
 * Build a histogram metric from raw numeric samples. Computes bucketCounts so
 * that bucketCounts.length === bounds.length + 1 and count === sum of
 * bucketCounts, the two invariants a receiver silently drops a point for
 * violating (see otlp-metrics.mjs buildHistogramMetric).
 *
 * @param {number[]} samples
 * @param {object} opts
 * @param {string} opts.name
 * @param {string} opts.stream
 * @param {number[]} opts.bounds
 * @param {number} opts.timeUnixMs
 * @param {object} [opts.attributes]
 * @returns {object[]} zero or one histogram record
 */
export function histogramFrom(
  samples,
  { name, stream, bounds, timeUnixMs, startTimeUnixMs, attributes },
) {
  const values = samples.filter((v) => Number.isFinite(v));
  if (values.length === 0) return [];
  const bucketCounts = new Array(bounds.length + 1).fill(0);
  for (const v of values) {
    let i = bounds.findIndex((b) => v <= b);
    if (i === -1) i = bounds.length;
    bucketCounts[i] += 1;
  }
  return [
    {
      name: `${METRIC_PREFIX}.${name}`,
      type: 'histogram',
      count: values.length,
      sum: values.reduce((a, b) => a + b, 0),
      bucketCounts,
      explicitBounds: bounds,
      timeUnixMs,
      startTimeUnixMs: startTimeUnixMs ?? timeUnixMs,
      stream,
      ...(attributes ? { attributes } : {}),
    },
  ];
}
