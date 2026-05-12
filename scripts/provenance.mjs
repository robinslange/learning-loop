#!/usr/bin/env node
// provenance.mjs — Append-only provenance event emitter
// Usage as module: import { emitProvenance } from './provenance.mjs'
// Usage as CLI:    node provenance.mjs '{"agent":"x","action":"create","target":"y.md"}'

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { appendJsonlLine } from './lib/jsonl.mjs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getPluginData } from './lib/config.mjs';
import { logError } from './lib/log.mjs';

const PROVENANCE_DIR = join(getPluginData(), 'provenance');
const TEMPLATE_DIR = join(import.meta.dirname, '..', 'provenance');

function getSessionId() {
  const tmp = tmpdir();
  // Try the ppid-suffixed file first, then the unsuffixed legacy fallback.
  // Both being absent is expected when provenance fires outside of a
  // Claude Code session (CLI invocation, cron, tests) — don't log ENOENT.
  // Only surface errors when a file *exists* but can't be read (perms, IO).
  const candidates = [
    join(tmp, `learning-loop-session-id-${process.ppid}`),
    join(tmp, 'learning-loop-session-id'),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      return readFileSync(path, 'utf8').trim();
    } catch (err) {
      logError('provenance.getSessionId.read', { path, err: err.message });
    }
  }
  return 'unknown';
}

function getCurrentMonthFile() {
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return join(PROVENANCE_DIR, `events-${month}.jsonl`);
}

let _seeded = false;
function seedTemplates() {
  if (_seeded) return;
  for (const name of ['learned-patterns.md', 'retired-patterns.md']) {
    const dest = join(PROVENANCE_DIR, name);
    if (!existsSync(dest)) {
      const src = join(TEMPLATE_DIR, name);
      if (existsSync(src)) copyFileSync(src, dest);
    }
  }
  _seeded = true;
}

export function emitProvenance(event) {
  mkdirSync(PROVENANCE_DIR, { recursive: true });
  seedTemplates();
  const record = {
    ts: new Date().toISOString(),
    session_id: getSessionId(),
    source: 'skill',
    ...event,
  };
  appendJsonlLine(getCurrentMonthFile(), record);
}

if (process.argv[2]) {
  try {
    emitProvenance(JSON.parse(process.argv[2]));
  } catch (e) {
    console.error('provenance emit failed:', e.message);
    process.exit(1);
  }
}
