#!/usr/bin/env node
// provenance.mjs — Append-only provenance event emitter
// Usage as module: import { emitProvenance } from './provenance.mjs'
// Usage as CLI:    node provenance.mjs '{"agent":"x","action":"create","target":"y.md"}'

import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getPluginData } from './lib/config.mjs';

const PROVENANCE_DIR = join(getPluginData(), 'provenance');
const TEMPLATE_DIR = join(import.meta.dirname, '..', 'provenance');

function getSessionId() {
  try {
    return readFileSync(join(tmpdir(), 'learning-loop-session-id'), 'utf8').trim();
  } catch {
    return 'unknown';
  }
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
  appendFileSync(getCurrentMonthFile(), JSON.stringify(record) + '\n');
}

if (process.argv[2]) {
  try {
    emitProvenance(JSON.parse(process.argv[2]));
  } catch (e) {
    console.error('provenance emit failed:', e.message);
    process.exit(1);
  }
}
