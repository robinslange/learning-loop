// scripts/otel/reducers/session.mjs : the session-summary reducer.
//
// Reads session-summary records off the provenance stream (they are provenance
// actions; the provenance reducer also counts them under provenance_actions),
// collapses to one record per session, and emits a session counter plus one
// histogram per numeric field. Whole-corpus re-derivation like its siblings.

import {
  readRecords,
  monthlyFiles,
  countBy,
  histogramFrom,
  LATENCY_BOUNDS_MS,
} from '../reduce.mjs';
import { DATA_PATHS } from '../../lib/paths.mjs';

const STREAM = 'session';
const COUNT_BOUNDS = [0, 1, 2, 5, 10, 25, 50, 100];
const BYTE_BOUNDS = [1e4, 1e5, 1e6, 4e6, 1.6e7];
const DURATION_BOUNDS_MS = [60e3, 300e3, 900e3, 1800e3, 3600e3, 7200e3];

const HISTOGRAMS = [
  ['prompts', COUNT_BOUNDS],
  ['tool_uses', COUNT_BOUNDS],
  ['tool_uses_direct', COUNT_BOUNDS],
  ['files_edited', COUNT_BOUNDS],
  ['commits', COUNT_BOUNDS],
  ['skills_invoked', COUNT_BOUNDS],
  ['agents_spawned', COUNT_BOUNDS],
  ['transcript_bytes', BYTE_BOUNDS],
  ['duration_ms', DURATION_BOUNDS_MS],
  ['latency_ms', LATENCY_BOUNDS_MS],
  ['git_ms', LATENCY_BOUNDS_MS],
];

function latestPerSession(records) {
  const best = new Map();
  for (const r of records) {
    if (!r.session_id) continue;
    const prev = best.get(r.session_id);
    if (!prev) {
      best.set(r.session_id, r);
      continue;
    }
    // A final record is authoritative whatever its timestamp; between two
    // non-final (or two final) records the later one wins.
    if (prev.final === true && r.final !== true) continue;
    if (r.final === true && prev.final !== true) {
      best.set(r.session_id, r);
      continue;
    }
    if (String(r.ts) > String(prev.ts)) best.set(r.session_id, r);
  }
  return [...best.values()];
}

export function reduceSession({ pluginData, timeUnixMs }) {
  const files = monthlyFiles(DATA_PATHS.provenance(pluginData), 'events-');
  const sessions = latestPerSession(
    readRecords(files).filter((r) => r.action === 'session-summary'),
  );
  if (sessions.length === 0) return [];
  return [
    ...countBy(sessions, {
      name: 'session_count',
      stream: STREAM,
      by: ['end_reason', 'git_state', 'project_source', 'harness', 'final'],
      timeUnixMs,
    }),
    ...HISTOGRAMS.flatMap(([field, bounds]) =>
      histogramFrom(
        sessions.map((s) => s[field]),
        { name: `session_${field}`, stream: STREAM, bounds, timeUnixMs },
      ),
    ),
  ];
}
