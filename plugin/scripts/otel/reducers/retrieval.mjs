// scripts/otel/reducers/retrieval.mjs : T2d, the retrieval stream reducer.
//
// See docs/plans/otel-consolidation.md, "Phase 2: aggregators and POST",
// signal mapping: "retrieval streams to counters plus result_count
// histograms, labelled by command, via, level, federated." Four sibling
// streams under DATA_PATHS.retrieval share one reducer: queries, reads,
// injections and shadow-injection. cache-health and session-start-pack live
// in the same directory but are owned by other reducers, so the prefix match
// below must stay precise.
//
// Follows reduce.mjs's contract: whole-corpus re-derive, no watermark. Two
// runs over the same files produce byte-identical output.

import { DATA_PATHS } from '../../lib/paths.mjs';
import {
  readRecords,
  monthlyFiles,
  countBy,
  histogramFrom,
  METRIC_PREFIX,
  LATENCY_BOUNDS_MS,
} from '../reduce.mjs';

const STREAM = 'retrieval';

// Small-integer result counts, not a ratio or a latency: RATIO_BOUNDS and
// LATENCY_BOUNDS_MS both fit the wrong shape of data. 0/1 separate "nothing
// found" and "exactly one hit" as their own buckets; 2, 5, 10, 25 spread the
// rest of the range a typical search or read returns.
const RESULT_COUNT_BOUNDS = [0, 1, 2, 5, 10, 25];

// Character counts, not result counts: a shadow-injection prompt runs to
// hundreds or thousands of characters, so the bounds are two orders of
// magnitude wider than RESULT_COUNT_BOUNDS.
const PROMPT_LENGTH_BOUNDS = [50, 200, 500, 1000, 2000, 5000];

// One reducer, four streams, each contributing a `command` counted by the
// same metric. Data-driven so four copy-pasted blocks are not needed (plan's
// invariant 7 note: reducers stay under the 150 LOC script cap).
const STREAMS = [{ prefix: 'queries-' }, { prefix: 'reads-' }, { prefix: 'shadow-injection-' }];

function readStream(pluginData, prefix) {
  const dir = DATA_PATHS.retrieval(pluginData);
  return readRecords(monthlyFiles(dir, prefix));
}

/**
 * Reduce the four retrieval streams (queries, reads, injections,
 * shadow-injection) to metric records: counts by command, counts by
 * via/level for injections, counts by federated (queries), a result_count
 * histogram across the query-shaped streams, and a latency_ms histogram
 * from shadow-injection, the only stream that records a duration today.
 *
 * `type` (on reads) is NOT exported: it is not a key in schema.mjs's
 * EXPORT_SCHEMA.retrieval, and phase 0 fails closed on an unlisted key
 * rather than passing it through.
 *
 * @param {object} opts
 * @param {string} opts.pluginData  CLAUDE_PLUGIN_DATA root
 * @param {number} opts.timeUnixMs
 * @returns {object[]} metric records, stream: 'retrieval'
 */
export function reduceRetrieval({ pluginData, timeUnixMs }) {
  const queries = readStream(pluginData, 'queries-');
  const commandRecords = STREAMS.flatMap(({ prefix }) => readStream(pluginData, prefix));
  const injections = readStream(pluginData, 'injections-');

  const metrics = [
    ...countBy(commandRecords, {
      name: 'retrieval_command',
      stream: STREAM,
      by: ['command'],
      timeUnixMs,
    }),
    ...countBy(injections, {
      name: 'retrieval_injection_via',
      stream: STREAM,
      by: ['via'],
      timeUnixMs,
    }),
    ...countBy(injections, {
      name: 'retrieval_injection_level',
      stream: STREAM,
      by: ['level'],
      timeUnixMs,
    }),
    ...countBy(queries, {
      name: 'retrieval_federated',
      stream: STREAM,
      by: ['federated'],
      timeUnixMs,
    }),
    ...histogramFrom(
      commandRecords.map((r) => r.result_count).filter((v) => typeof v === 'number'),
      { name: 'retrieval_result_count', stream: STREAM, bounds: RESULT_COUNT_BOUNDS, timeUnixMs },
    ),
    ...histogramFrom(
      commandRecords.map((r) => r.latency_ms).filter((v) => typeof v === 'number'),
      { name: 'retrieval_latency_ms', stream: STREAM, bounds: LATENCY_BOUNDS_MS, timeUnixMs },
    ),
    ...histogramFrom(
      commandRecords.map((r) => r.prompt_length).filter((v) => typeof v === 'number'),
      { name: 'retrieval_prompt_length', stream: STREAM, bounds: PROMPT_LENGTH_BOUNDS, timeUnixMs },
    ),
  ];

  return metrics;
}
