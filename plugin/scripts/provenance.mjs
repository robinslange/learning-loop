#!/usr/bin/env node
// provenance.mjs — Append-only provenance event emitter
// Usage as module: import { emitProvenance } from './provenance.mjs'
// Usage as CLI:    node provenance.mjs '{"agent":"x","action":"create","target":"y.md"}'

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { appendJsonlLineDeduped } from './lib/jsonl.mjs';
import { join } from 'node:path';
import { isMainModule } from './lib/is-main.mjs';
import { getPluginData, pluginDataExists } from './lib/config.mjs';
import { getSessionId } from './lib/session.mjs';
import { DATA_PATHS } from './lib/paths.mjs';
import { VALID_ACTIONS, INTENT_KINDS } from './lib/provenance-vocabulary.mjs';
import { logError } from './lib/log.mjs';

// Resolved lazily, not at module load: getPluginData() can be null, and an
// eager join would throw before emitProvenance's guard ever runs.
function provenanceDir() {
  return DATA_PATHS.provenance(getPluginData());
}

const TEMPLATE_DIR = join(import.meta.dirname, '..', 'provenance');

function getCurrentMonthFile() {
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return join(provenanceDir(), `events-${month}.jsonl`);
}

let _seeded = false;
function seedTemplates() {
  if (_seeded) return;
  for (const name of ['learned-patterns.md', 'retired-patterns.md']) {
    const dest = join(provenanceDir(), name);
    if (!existsSync(dest)) {
      const src = join(TEMPLATE_DIR, name);
      if (existsSync(src)) copyFileSync(src, dest);
    }
  }
  _seeded = true;
}

export function emitProvenance(event) {
  // Reject unknown actions at the boundary instead of letting the unchecked
  // spread below shape the schema. Legacy spellings are readable but not
  // emittable. Now a counted rejection: log.mjs's error sink persists this
  // scope durably, and the phase 2 reducer counts records by scope.
  if (!event || !VALID_ACTIONS.has(event.action)) {
    logError('provenance.invalidAction', new Error(`unknown action: ${event && event.action}`));
    return;
  }
  // Guards the detached-child resurrection class, see pluginDataExists().
  if (!pluginDataExists()) return;
  mkdirSync(provenanceDir(), { recursive: true });
  seedTemplates();
  const record = {
    ts: new Date().toISOString(),
    session_id: getSessionId(),
    source: 'skill',
    ...event,
  };
  // Free-text intent (or an unbounded intent_kind) is dropped, not the whole
  // event: the rest of the record is still useful, and rejecting outright
  // would throw away real skill/action/target data over one bad field. Now a
  // counted drop: log.mjs's error sink persists this scope durably, and the
  // phase 2 reducer counts records by scope.
  if ('intent' in record) {
    logError('provenance.freeTextIntent', new Error(`dropping free-text intent: ${record.intent}`));
    delete record.intent;
  }
  if ('intent_kind' in record && !INTENT_KINDS.has(record.intent_kind)) {
    logError(
      'provenance.freeTextIntent',
      new Error(`dropping unbounded intent_kind: ${record.intent_kind}`),
    );
    delete record.intent_kind;
  }
  appendJsonlLineDeduped(getCurrentMonthFile(), record);
}

const isMain = isMainModule(import.meta.url);
if (isMain && process.argv[2]) {
  try {
    emitProvenance(JSON.parse(process.argv[2]));
  } catch (e) {
    console.error('provenance emit failed:', e.message);
    process.exit(1);
  }
}
