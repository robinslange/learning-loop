#!/usr/bin/env node
// provenance.mjs — Append-only provenance event emitter
// Usage as module: import { emitProvenance } from './provenance.mjs'
// Usage as CLI:    node provenance.mjs '{"agent":"x","action":"create","target":"y.md"}'

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { appendJsonlLine } from './lib/jsonl.mjs';
import { join } from 'node:path';
import { getPluginData } from './lib/config.mjs';
import { getSessionId } from './lib/session.mjs';
import { DATA_PATHS } from './lib/paths.mjs';

const PROVENANCE_DIR = DATA_PATHS.provenance(getPluginData());
const TEMPLATE_DIR = join(import.meta.dirname, '..', 'provenance');

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
  // Never resurrect a deleted plugin-data: session-start spawns this emitter
  // detached, so it can outlive a test sandbox's cleanup — mkdirSync here
  // re-created rmSync'd sandboxes (the residual ll-hook-sb-* leak, 2026-06).
  // Real installs always have an existing plugin-data, so this never no-ops
  // for them.
  const pluginData = getPluginData();
  if (!pluginData || !existsSync(pluginData)) return;
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
