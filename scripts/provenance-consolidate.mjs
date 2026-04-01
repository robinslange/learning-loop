#!/usr/bin/env node

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getPluginData } from './lib/config.mjs';

const PROVENANCE_DIR = join(getPluginData(), 'provenance');

function readEventLogs() {
  const events = [];
  if (!existsSync(PROVENANCE_DIR)) return events;

  for (const file of readdirSync(PROVENANCE_DIR)) {
    if (!file.startsWith('events-') || !file.endsWith('.jsonl')) continue;
    const lines = readFileSync(join(PROVENANCE_DIR, file), 'utf-8')
      .split('\n')
      .filter(Boolean);
    for (const line of lines) {
      try { events.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }
  }

  return events;
}

function aggregateByDay(events) {
  const days = new Map();

  for (const event of events) {
    const day = event.ts?.slice(0, 10);
    if (!day) continue;

    if (!days.has(day)) {
      days.set(day, { sessions: new Set(), events: {} });
    }
    const bucket = days.get(day);

    if (event.session_id) bucket.sessions.add(event.session_id);

    const skill = event.skill || event.agent || event.action || 'unknown';
    if (!bucket.events[skill]) {
      bucket.events[skill] = { sessions: new Set(), notes_created: 0, fixes: 0, promotions: 0 };
    }
    const entry = bucket.events[skill];
    if (event.session_id) entry.sessions.add(event.session_id);

    if (event.action === 'vault-write') entry.notes_created++;
    if (event.action === 'fix' || event.action === 'verify-fix') entry.fixes++;
    if (event.action === 'promote') entry.promotions++;
  }

  const result = [];
  for (const [day, data] of [...days.entries()].sort()) {
    const events = {};
    for (const [skill, entry] of Object.entries(data.events)) {
      events[skill] = {
        sessions: entry.sessions.size,
        notes_created: entry.notes_created,
        ...(entry.fixes > 0 && { fixes: entry.fixes }),
        ...(entry.promotions > 0 && { promotions: entry.promotions }),
      };
    }
    result.push({
      period: day,
      tier: 1,
      total_sessions: data.sessions.size,
      events,
    });
  }

  return result;
}

const events = readEventLogs();
if (events.length === 0) {
  console.log(JSON.stringify({ summaries: [], event_count: 0 }));
} else {
  const summaries = aggregateByDay(events);
  const output = { summaries, event_count: events.length };

  const pluginData = getPluginData();
  const outDir = join(pluginData, 'federation');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, 'provenance-local.json'),
    JSON.stringify(output, null, 2) + '\n'
  );

  console.log(JSON.stringify(output, null, 2));
}
