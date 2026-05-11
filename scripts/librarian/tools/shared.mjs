// scripts/librarian/tools/shared.mjs : shared utilities for librarian tools.
//
// Provides DB access, cap/slug helpers, query functions, and submit primitives
// (submitLink, submitSuspect) used across tool modules.

import { readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { run } from '../../lib/binary.mjs';
import { openReadonly } from '../../lib/sqljs.mjs';
import {
  appendItem,
  newItemId,
  loadState,
  saveState,
  incrementCounter,
  readQueue,
} from '../queue.mjs';
import { VAULT_PATH, DB_PATH } from '../../lib/constants.mjs';
import { logError } from '../../lib/log.mjs';

export const MAX_RESULT = 1500;

export function cap(str) {
  if (typeof str !== 'string') str = JSON.stringify(str);
  return str.length > MAX_RESULT ? str.slice(0, MAX_RESULT) + '…' : str;
}

export function slug(notePath) {
  const name = notePath.split('/').pop();
  return name.replace(/\.md$/, '');
}

export function isUnitProb(x) {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;
}

let _db = null;

export async function getDb() {
  if (_db) return _db;
  _db = await openReadonly(DB_PATH);
  return _db;
}

export async function findSimilar({ note_path }, ctx) {
  const results = run(['similar', DB_PATH, note_path, '--top', '5']);
  if (ctx && ctx.neighbourScores && Array.isArray(results)) {
    for (const r of results) {
      if (r && typeof r.path === 'string' && typeof r.score === 'number') {
        ctx.neighbourScores.set(r.path, r.score);
      }
    }
  }
  return cap(JSON.stringify(results));
}

export async function searchVault({ query }) {
  const results = run(['query', DB_PATH, query, '--top', '5']);
  return cap(JSON.stringify(results));
}

export async function findClusters() {
  const results = run(['cluster', DB_PATH, '--threshold', '0.85']);
  return cap(JSON.stringify(results));
}

export async function getInlinks({ note_path }) {
  const db = await getDb();
  const s = slug(note_path);
  const rows = db.exec(
    "SELECT COUNT(*) as count FROM links WHERE target_path = ? AND target_path NOT LIKE '%[%'",
    [s],
  );
  if (!rows.length) return '0';
  const count = rows[0].values[0][0];
  return String(count);
}

export async function getOutlinks({ note_path }) {
  const db = await getDb();
  const rows = db.exec(
    "SELECT target_path FROM links WHERE source_path = ? AND target_path NOT LIKE '%[%'",
    [note_path],
  );
  if (!rows.length) return cap(JSON.stringify([]));
  const targets = rows[0].values.map((r) => r[0]);
  return cap(JSON.stringify(targets));
}

export async function getTags() {
  const results = run(['tags', DB_PATH]);
  return cap(JSON.stringify(results));
}

export async function readNote({ note_path }) {
  const fullPath = join(VAULT_PATH, note_path);
  if (!existsSync(fullPath)) return 'Note not found: ' + note_path;
  let content = readFileSync(fullPath, 'utf-8');
  if (content.startsWith('---')) {
    const end = content.indexOf('\n---', 3);
    if (end !== -1) {
      content = content.slice(end + 4).trimStart();
    }
  }
  return cap(content.slice(0, 500));
}

export async function submitLink({
  target,
  suggested_link,
  confidence,
  reason,
  cosine_score,
  model_prob,
}) {
  const targetFullPath = join(VAULT_PATH, target);
  if (!existsSync(targetFullPath)) {
    let state = loadState();
    state = incrementCounter(state, 'rejected_missing_target');
    saveState(state);
    return 'Rejected: target file does not exist';
  }

  if (target === suggested_link) {
    let state = loadState();
    state = incrementCounter(state, 'rejected_self_link');
    saveState(state);
    return 'Rejected: self-link';
  }

  const fullSuggestedPath = join(VAULT_PATH, suggested_link);
  if (!existsSync(fullSuggestedPath)) {
    let state = loadState();
    state = incrementCounter(state, 'rejected_missing_file');
    saveState(state);
    return 'Rejected: suggested_link file does not exist';
  }

  const suggestedSlug = basename(suggested_link, '.md');
  const targetContent = readFileSync(targetFullPath, 'utf-8');
  const escapedSlug = suggestedSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const linkPattern = new RegExp('\\[\\[' + escapedSlug + '(\\|[^\\]]*)?\\]\\]');
  if (linkPattern.test(targetContent)) {
    let state = loadState();
    state = incrementCounter(state, 'rejected_already_linked');
    saveState(state);
    return 'Rejected: link already present in target note';
  }

  const existing = readQueue().find(
    (q) =>
      q.task === 'link_suggestion' &&
      q.target === target &&
      q.suggested_link === suggested_link &&
      (q.status === 'pending' || q.status === 'acknowledged'),
  );
  if (existing) {
    let state = loadState();
    state = incrementCounter(state, 'rejected_duplicate');
    saveState(state);
    return 'Rejected: duplicate suggestion already queued';
  }

  const item = {
    id: newItemId(),
    task: 'link_suggestion',
    target,
    suggested_link,
    confidence,
    reason,
    status: 'pending',
    created_at: new Date().toISOString(),
  };
  if (isUnitProb(cosine_score)) item.cosine_score = cosine_score;
  if (isUnitProb(model_prob)) item.model_prob = model_prob;
  appendItem(item);

  let state = loadState();
  state = { ...state, link_suggestions: (state.link_suggestions || 0) + 1 };
  saveState(state);

  return 'Queued link suggestion: ' + item.id;
}

export async function submitSuspect({ target, reason }) {
  const item = {
    id: newItemId(),
    task: 'staleness_suspect',
    target,
    reason,
    status: 'pending',
    created_at: new Date().toISOString(),
  };
  appendItem(item);

  let state = loadState();
  state = { ...state, staleness_suspects: (state.staleness_suspects || 0) + 1 };
  saveState(state);

  return 'Queued suspect: ' + item.id;
}
