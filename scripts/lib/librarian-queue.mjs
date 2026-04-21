import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { getPluginData } from './config.mjs';

function librarianDir() {
  const pd = getPluginData();
  if (!pd) throw new Error('PLUGIN_DATA not available');
  return join(pd, 'librarian');
}

function queuePath() {
  return join(librarianDir(), 'queue.jsonl');
}

function statePath() {
  return join(librarianDir(), 'state.json');
}

export function ensureDir() {
  mkdirSync(librarianDir(), { recursive: true });
}

export function appendItem(item) {
  ensureDir();
  writeFileSync(queuePath(), JSON.stringify(item) + '\n', { flag: 'a', encoding: 'utf-8' });
}

export function readQueue() {
  const p = queuePath();
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8')
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line));
}

export function pendingItems() {
  return readQueue().filter(item => item.status === 'pending');
}

export function pendingCount() {
  return pendingItems().length;
}

export function updateItem(id, updates) {
  const items = readQueue().map(item =>
    item.id === id ? { ...item, ...updates } : item
  );
  ensureDir();
  writeFileSync(queuePath(), items.map(item => JSON.stringify(item)).join('\n') + '\n', 'utf-8');
}

export function expireStaleItems(vaultPath) {
  const now = Date.now();
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  const items = readQueue().map(item => {
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
    } catch {
      // file missing — expire it
      return { ...item, status: 'expired', expired_reason: 'target_missing' };
    }
    return item;
  });
  ensureDir();
  writeFileSync(queuePath(), items.map(item => JSON.stringify(item)).join('\n') + '\n', 'utf-8');
}

const DEFAULT_STATE = {
  visited: [],
  notes_visited: 0,
  link_suggestions: 0,
  voice_flags: 0,
  staleness_suspects: 0,
  last_note: null,
  started_at: null,
};

export function loadState() {
  const p = statePath();
  if (!existsSync(p)) return { ...DEFAULT_STATE };
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveState(state) {
  ensureDir();
  writeFileSync(statePath(), JSON.stringify(state, null, 2) + '\n', 'utf-8');
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
