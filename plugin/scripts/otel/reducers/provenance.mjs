// scripts/otel/reducers/provenance.mjs : T2b, the provenance stream reducer.
//
// See docs/plans/otel-consolidation.md, "Phase 2: aggregators and POST",
// signal mapping: "provenance to counts by action, skill/agent, folder".
// Decision (b) in 1e-bis: agent is the primary dimension, not skill, since
// skill is absent from 80% of events and cannot be derived for agent-result.
// skill is still counted where it is genuinely present.
//
// Follows reduce.mjs's whole-corpus contract: read every events-*.jsonl file,
// recompute from scratch, return metric records. No watermark, no cursor.

import { readRecords, monthlyFiles, countBy, earliestTimestamp } from '../reduce.mjs';
import { DATA_PATHS } from '../../lib/paths.mjs';
import { isKnownAction } from '../../lib/provenance-vocabulary.mjs';

const STREAM = 'provenance';

/**
 * Reduce the whole provenance corpus to counter metrics: counts by action,
 * agent, skill and folder. Re-derived from scratch on every call, so running
 * it twice against the same corpus returns identical output.
 *
 * @param {object} opts
 * @param {string} opts.pluginData  CLAUDE_PLUGIN_DATA root
 * @param {number} opts.timeUnixMs
 * @returns {object[]} counter metric records, stream: 'provenance'
 */
export function reduceProvenance({ pluginData, timeUnixMs }) {
  const dir = DATA_PATHS.provenance(pluginData);
  const files = monthlyFiles(dir, 'events-');
  const records = readRecords(files);
  // Stable across runs: the corpus's own earliest event, not this run's clock.
  const startTimeUnixMs = earliestTimestamp(records, timeUnixMs);

  // A garbage or corrupted action must never invent a metric label. Legacy
  // spellings (write, demote, ...) are real history and stay countable.
  const known = records.filter((r) => isKnownAction(r.action));

  return [
    ...countBy(known, {
      name: 'provenance_actions',
      stream: STREAM,
      by: ['action'],
      timeUnixMs,
      startTimeUnixMs,
    }),
    ...countBy(known, {
      name: 'provenance_agent',
      stream: STREAM,
      by: ['agent'],
      timeUnixMs,
      startTimeUnixMs,
    }),
    ...countBy(known, {
      name: 'provenance_skill',
      stream: STREAM,
      by: ['skill'],
      timeUnixMs,
      startTimeUnixMs,
    }),
    ...countBy(known, {
      name: 'provenance_folder',
      stream: STREAM,
      by: ['folder'],
      timeUnixMs,
      startTimeUnixMs,
    }),
  ];
}
