#!/usr/bin/env node

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getPluginData } from './lib/config.mjs';
import { logError } from './lib/log.mjs';
import { DATA_PATHS } from './lib/paths.mjs';
import { isKnownAction } from './lib/provenance-vocabulary.mjs';

const PROVENANCE_DIR = DATA_PATHS.provenance(getPluginData());

function readEventLogs() {
  const events = [];
  if (!existsSync(PROVENANCE_DIR)) return events;

  for (const file of readdirSync(PROVENANCE_DIR)) {
    if (!file.startsWith('events-') || !file.endsWith('.jsonl')) continue;
    const lines = readFileSync(join(PROVENANCE_DIR, file), 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        events.push(JSON.parse(line));
      } catch (err) {
        logError('provenance-consolidate.parseLine', err);
      }
    }
  }

  return events;
}

// Per decision (b) in 1e-bis: `agent` is the primary dimension because it is
// derivable at spawn points, while `skill` is absent from 80% of events
// (notably every agent-result) and cannot be reconstructed without parsing
// transcripts. So a labelled event picks exactly one of three named
// dimensions, agent first, never a collapsed "skill" bucket that hides which
// one it actually came from. `unknown` bucket removed: an event with no
// agent, skill or action also has no ts filter to reach here in practice, but
// if one did, action is always present upstream (1e rejects a missing
// action), so the fallback chain never runs dry.
function dimensionFor(event) {
  if (event.agent) return { kind: 'agents', key: event.agent };
  if (event.skill) return { kind: 'skills', key: event.skill };
  return { kind: 'actions', key: event.action };
}

function aggregateByDay(events) {
  const days = new Map();

  for (const event of events) {
    const day = event.ts?.slice(0, 10);
    if (!day) continue;
    if (!isKnownAction(event.action)) continue;

    if (!days.has(day)) {
      days.set(day, { sessions: new Set(), agents: {}, skills: {}, actions: {} });
    }
    const bucket = days.get(day);

    if (event.session_id) bucket.sessions.add(event.session_id);

    const { kind, key } = dimensionFor(event);
    const dimension = bucket[kind];
    if (!dimension[key]) {
      dimension[key] = { sessions: new Set(), notes_created: 0, promotions: 0 };
    }
    const entry = dimension[key];
    if (event.session_id) entry.sessions.add(event.session_id);

    if (event.action === 'vault-write') entry.notes_created++;
    // batch-promote is the real, live top-level promotion action
    // (skills/verify/SKILL.md); `promote` never fires as a top-level action,
    // it only ever appears nested inside a batch-score payload, so it is not
    // counted here. `fix`/`verify-fix` have no emitter anywhere in the
    // codebase and are not in VALID_ACTIONS or LEGACY_ACTIONS, so there is no
    // fixes counter: inventing one would count an action that never happens.
    if (event.action === 'batch-promote') entry.promotions++;
  }

  const result = [];
  for (const [day, data] of [...days.entries()].sort()) {
    const output = { period: day, tier: 1, total_sessions: data.sessions.size };
    for (const kind of ['agents', 'skills', 'actions']) {
      const dimension = {};
      for (const [key, entry] of Object.entries(data[kind])) {
        dimension[key] = {
          sessions: entry.sessions.size,
          notes_created: entry.notes_created,
          ...(entry.promotions > 0 && { promotions: entry.promotions }),
        };
      }
      output[kind] = dimension;
    }
    result.push(output);
  }

  return result;
}

const events = readEventLogs();
if (events.length === 0) {
  console.log(JSON.stringify({ summaries: [], event_count: 0 }));
} else {
  const summaries = aggregateByDay(events);
  // event_count is a read-side count of every line that parsed as JSON,
  // including one with an action outside VALID_ACTIONS/LEGACY_ACTIONS (which
  // aggregateByDay skips from the per-day buckets above). Records that 1e's
  // emit-boundary validator rejects never reach disk at all, so they never
  // enter readEventLogs() and never inflate this count; nothing to filter
  // here for that case.
  const output = { summaries, event_count: events.length };

  // T1h federation decision: coexist, not subsumed by OTLP. federation is
  // peer-to-peer count sharing across machines with no shared LAN and no
  // Grafana in common; OTLP (phase 2) exports session-correlated detail to
  // one private Grafana on this operator's own LAN. Different audiences,
  // different trust boundaries, so provenance-local.json stays as the
  // federation artifact and is not retired when OTLP export ships.
  const pluginData = getPluginData();
  const outDir = DATA_PATHS.federation(pluginData);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'provenance-local.json'), JSON.stringify(output, null, 2) + '\n');

  console.log(JSON.stringify(output, null, 2));
}
