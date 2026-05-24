// scripts/librarian/queue.mjs : persistent JSONL work queue for the librarian daemon.
//
// Migrated from scripts/lib/librarian-queue.mjs (phase 1H). Adopts:
//   - safeLoad() for state.json reads
//   - withLock() for mutating writes (updateItem, expireStaleItems, saveState)
//   - logError() instead of bare catch {}
//
// appendItem uses flag:'a' (atomic append on POSIX); no lock needed for append-only.
// readQueue reads JSONL line-by-line without JSON.parse(readFileSync) monolith.
//
// The shim at scripts/lib/librarian-queue.mjs re-exports every symbol here;
// do not remove until phase 2 removes the shim.

import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getPluginData } from '../lib/config.mjs';
import { safeLoad } from '../lib/safe-load.mjs';
import { withLock } from '../lib/file-lock.mjs';
import { logError } from '../lib/log.mjs';
import { DATA_PATHS } from '../lib/paths.mjs';

function librarianDir() {
  const pd = getPluginData();
  if (!pd) throw new Error('PLUGIN_DATA not available');
  return DATA_PATHS.librarian(pd);
}

function queuePath() {
  const pd = getPluginData();
  if (!pd) throw new Error('PLUGIN_DATA not available');
  return DATA_PATHS.librarianQueue(pd);
}

function statePath() {
  return join(librarianDir(), 'state.json');
}

export function ensureDir() {
  mkdirSync(librarianDir(), { recursive: true });
}

export function appendItem(item) {
  ensureDir();
  appendFileSync(queuePath(), JSON.stringify(item) + '\n', { encoding: 'utf-8' });
}

export function readQueue() {
  const p = queuePath();
  if (!existsSync(p)) return [];
  let raw;
  try {
    raw = readFileSync(p, 'utf-8');
  } catch (e) {
    logError('librarian-queue:read', e);
    return [];
  }
  return raw
    .split('\n')
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch (e) {
        logError('librarian-queue:parse', e, { line: line.slice(0, 80) });
        return [];
      }
    });
}

export function pendingItems() {
  return readQueue().filter((item) => item.status === 'pending');
}

export function pendingCount() {
  return pendingItems().length;
}

export function updateItem(id, updates) {
  withLock(queuePath(), {}, () => {
    const items = readQueue().map((item) => (item.id === id ? { ...item, ...updates } : item));
    ensureDir();
    writeFileSync(
      queuePath(),
      items.map((item) => JSON.stringify(item)).join('\n') + '\n',
      'utf-8',
    );
  });
}

export function expireStaleItems(vaultPath) {
  withLock(queuePath(), {}, () => {
    const now = Date.now();
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    const items = readQueue().map((item) => {
      if (item.status !== 'pending') return item;
      const created = new Date(item.created_at).getTime();
      if (now - created > thirtyDays) {
        return { ...item, status: 'expired', expired_reason: 'stale' };
      }
      try {
        const fullPath = join(vaultPath, item.target);
        const mtime = statSync(fullPath).mtimeMs;
        if (mtime > created) {
          return { ...item, status: 'expired', expired_reason: 'target_changed' };
        }
      } catch (err) {
        logError('librarian-queue:expireStale', err);
        return { ...item, status: 'expired', expired_reason: 'target_missing' };
      }
      return item;
    });
    ensureDir();
    writeFileSync(
      queuePath(),
      items.map((item) => JSON.stringify(item)).join('\n') + '\n',
      'utf-8',
    );
  });
}

const DEFAULT_STATE = {
  visited: [],
  notes_visited: 0,
  link_suggestions: 0,
  voice_flags: 0,
  staleness_suspects: 0,
  counters: {},
  last_note: null,
  started_at: null,
};

export function loadState() {
  const { value } = safeLoad(statePath(), { fallback: null });
  if (!value || typeof value !== 'object') return { ...DEFAULT_STATE };
  if (!value.counters) value.counters = {};
  return value;
}

export function incrementCounter(state, key) {
  const counters = state.counters || {};
  return { ...state, counters: { ...counters, [key]: (counters[key] || 0) + 1 } };
}

export function saveState(state) {
  withLock(statePath(), {}, () => {
    ensureDir();
    writeFileSync(statePath(), JSON.stringify(state, null, 2) + '\n', 'utf-8');
  });
}

export function markVisited(state, notePath) {
  return {
    ...state,
    visited: [...(state.visited || []), notePath],
    notes_visited: (state.notes_visited || 0) + 1,
    last_note: notePath,
  };
}

export function resetState() {
  const p = statePath();
  if (existsSync(p)) unlinkSync(p);
}

export function newItemId() {
  return randomBytes(6).toString('hex');
}
