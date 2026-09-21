// scripts/otel/reducers/dream-eval.mjs : T2g, the dream-eval reducer.
//
// See docs/plans/otel-consolidation.md, "Phase 2: aggregators and POST",
// signal mapping: "dream-eval to counts by tier. No question."
//
// dream-eval is one of the three non-conforming envelopes the plan calls
// out: PLUGIN_DATA/dream-eval/probes.jsonl is a SINGLE file, not
// monthly-sharded, and its records carry no ts and no session_id
// ({tier, question, expected_files, source_session, confidence, probe_id}).
// The file only exists once dream mode has fired, so absent must return []
// cleanly, the same contract every other reducer has for an optional stream.
//
// Follows reduce.mjs's whole-corpus contract: read the whole file, recompute
// from scratch, return metric records. No watermark, no cursor.

import { statSync } from 'node:fs';
import { readRecords, countBy, histogramFrom, RATIO_BOUNDS } from '../reduce.mjs';
import { DATA_PATHS } from '../../lib/paths.mjs';

const STREAM = 'dream-eval';

/**
 * Reduce the whole dream-eval probes file to metric records: counts by tier
 * and a confidence histogram. question and expected_files are free text /
 * paths and are never read into an attribute. probe_id is not grouped on:
 * one metric per probe is unusable cardinality.
 *
 * @param {object} opts
 * @param {string} opts.pluginData  CLAUDE_PLUGIN_DATA root
 * @param {number} opts.timeUnixMs
 * @returns {object[]} metric records, stream: 'dream-eval'
 */
function fileBirthMs(file) {
  try {
    return statSync(file).birthtimeMs;
  } catch {
    return 0;
  }
}

export function reduceDreamEval({ pluginData, timeUnixMs }) {
  const file = DATA_PATHS.dreamEvalProbes(pluginData);
  const records = readRecords([file]);
  if (records.length === 0) return [];
  // This stream has no ts, so the corpus cannot supply a start. The file's
  // creation time is the next best stable anchor: it does not move between
  // runs the way the run clock does, and a start that moves every export makes
  // a cumulative counter look brand-new each hour. Filesystems without
  // birthtime report 0, so fall back to the run clock there rather than 1970.
  const startTimeUnixMs = fileBirthMs(file) || timeUnixMs;

  const confidences = records.map((r) => r.confidence).filter((v) => typeof v === 'number');

  return [
    ...countBy(records, {
      name: 'dream_eval.tier',
      stream: STREAM,
      by: ['tier'],
      timeUnixMs,
      startTimeUnixMs,
    }),
    ...histogramFrom(confidences, {
      name: 'dream_eval.confidence',
      stream: STREAM,
      bounds: RATIO_BOUNDS,
      timeUnixMs,
      startTimeUnixMs,
    }),
  ];
}
