// scripts/otel/reducers/librarian.mjs : T1j/T2f, the librarian queue reducer.
//
// PLUGIN_DATA/librarian/queue.jsonl (plan, "T1j: librarian queue metrics") is
// already metric-shaped: task, status and expired_reason are bounded enums,
// and the counts are the whole argument for exporting them. 92% of queued
// items expire, and of 2,686 voice_flag suggestions measured, zero were ever
// approved. That is invisible today because nothing reads this file; the
// task x status cross-product counter below is what makes it visible.
//
// The librarian is optional and off by default, so the file is commonly
// absent: readRecords already no-ops cleanly on a missing file, same as
// every other optional-stream reducer.
//
// Follows reduce.mjs's contract: whole-corpus re-derive, no watermark. Two
// runs over the same file produce byte-identical output.

import { DATA_PATHS } from '../../lib/paths.mjs';
import { readRecords, countBy, histogramFrom, METRIC_PREFIX, RATIO_BOUNDS } from '../reduce.mjs';

const STREAM = 'librarian';

// Age-until-resolution isn't recorded (queue.mjs overwrites a resolved item's
// status in place rather than logging a resolved_at), so the only lag this
// corpus can compute is age-until-now for items still PENDING: how long a
// suggestion has sat unreviewed. The measured oldest pending item is 12 days
// old, so hour buckets alone would blow past useful resolution; these bounds
// span an hour to two weeks, hour-scale at the front (where review usually
// happens) and day-scale past the first day.
const LAG_BOUNDS_MS = [
  3600_000,
  21600_000,
  86400_000,
  3 * 86400_000,
  7 * 86400_000,
  14 * 86400_000,
];

const SCORE_FIELDS = ['confidence', 'cosine_score', 'model_prob', 'similarity'];

/**
 * Reduce the whole librarian queue to metric records.
 * @param {object} opts
 * @param {string} opts.pluginData  PLUGIN_DATA root
 * @param {number} opts.timeUnixMs  export time, stamped on every point
 * @returns {object[]} otlp.mjs-shaped metric records
 */
export function reduceLibrarian({ pluginData, timeUnixMs }) {
  const records = readRecords([DATA_PATHS.librarianQueue(pluginData)]);
  if (records.length === 0) return [];

  const metrics = [
    ...countBy(records, {
      name: 'librarian.queue_by_task',
      stream: STREAM,
      by: ['task'],
      timeUnixMs,
    }),
    ...countBy(records, {
      name: 'librarian.queue_by_status',
      stream: STREAM,
      by: ['status'],
      timeUnixMs,
    }),
    ...countBy(records, {
      name: 'librarian.queue_by_expired_reason',
      stream: STREAM,
      by: ['expired_reason'],
      timeUnixMs,
    }),
    // The cross-product is what reveals a task type that never converts: a
    // consumer can filter task=voice_flag and see every status bucket it
    // has ever landed in, or notice the approved bucket is simply absent.
    ...countBy(records, {
      name: 'librarian.queue_by_task_status',
      stream: STREAM,
      by: ['task', 'status'],
      timeUnixMs,
    }),
  ];

  const pending = records.filter((r) => r.status === 'pending');
  metrics.push({
    name: `${METRIC_PREFIX}.librarian.queue_depth`,
    type: 'gauge',
    value: pending.length,
    timeUnixMs,
    stream: STREAM,
    attributes: {},
  });

  const lagSamples = pending
    .map((r) => timeUnixMs - Date.parse(r.created_at))
    .filter((ms) => Number.isFinite(ms) && ms >= 0);
  metrics.push(
    ...histogramFrom(lagSamples, {
      name: 'librarian.pending_lag_ms',
      stream: STREAM,
      bounds: LAG_BOUNDS_MS,
      timeUnixMs,
    }),
  );

  for (const field of SCORE_FIELDS) {
    const samples = records.map((r) => r[field]).filter((v) => typeof v === 'number');
    metrics.push(
      ...histogramFrom(samples, {
        name: `librarian.${field}`,
        stream: STREAM,
        bounds: RATIO_BOUNDS,
        timeUnixMs,
      }),
    );
  }

  return metrics;
}
