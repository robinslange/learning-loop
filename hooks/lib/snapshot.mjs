// hooks/lib/snapshot.mjs : On-disk vault-snapshot cache.
//
// Replaces the per-hook recursive-readdir of the seven vault folders with a
// JSON file at <plugin-data>/vault-snapshot.json that hot-path Write/Edit
// hooks load in microseconds. Daemon-side rebuilds are bounded by a 30s TTL;
// hook-side splice/remove keeps the cache fresh between rebuilds.

import { readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { join, basename, sep } from 'node:path';
import { resolvePluginData } from './common.mjs';
import { withLock, acquireLock, releaseLock } from '../../scripts/lib/file-lock.mjs';
import { safeLoad } from '../../scripts/lib/safe-load.mjs';
import { logError } from '../../scripts/lib/log.mjs';

export const SNAPSHOT_VERSION = 1;
export const TTL_MS = 30_000;

export const VAULT_DIRS = [
  '0-inbox',
  '1-fleeting',
  '2-literature',
  '3-permanent',
  '4-projects',
  '5-maps',
];

export const TITLE_INDEX_EXTRA_DIRS = ['Excalidraw'];

// Edge-classifier resolution priority: permanent wins over literature wins
// over inbox, etc. Mirrors scripts/lib/edge-classifier.mjs:VAULT_DIRS order.
const EDGE_PRIORITY_DIRS = [
  '3-permanent',
  '2-literature',
  '5-maps',
  '4-projects',
  '1-fleeting',
  '0-inbox',
];

function snapshotPath() {
  const pd = resolvePluginData();
  if (!pd) return null;
  return join(pd, 'vault-snapshot.json');
}

function nowIso() {
  return new Date().toISOString();
}

function expiresIso() {
  return new Date(Date.now() + TTL_MS).toISOString();
}

function attachRuntime(snap) {
  snap.relPathSet = new Set(snap.notes.map((n) => n.rel_path));
  return snap;
}

function writeSnapshot(snap) {
  const path = snapshotPath();
  if (!path) return;
  const { relPathSet, ...serialisable } = snap;
  const tmp = path + '.' + process.pid + '.tmp';
  writeFileSync(tmp, JSON.stringify(serialisable));
  renameSync(tmp, path);
}

function writeSnapshotLocked(snap) {
  const path = snapshotPath();
  if (!path) return;
  try {
    withLock(path, { retries: 5, retryDelayMs: 20 }, () => writeSnapshot(snap));
  } catch (err) {
    if (err.code === 'ELOCK_TIMEOUT') return;
    logError('snapshot.writeSnapshotLocked', err);
  }
}

// Re-reads the on-disk snapshot under lock, applies mutate(snap) → boolean,
// writes if mutate returned true, then releases the lock.
// Returns false if the lock could not be acquired or the path is unavailable.
function lockedMutate(mutate) {
  const path = snapshotPath();
  if (!path) return false;
  let handle;
  try {
    handle = acquireLock(path, { retries: 5, retryDelayMs: 20 });
  } catch (err) {
    logError('snapshot.lockedMutate.acquire', err);
    return false;
  }
  if (!handle) return false;
  try {
    const { value, error } = safeLoad(path);
    if (error || !value) return false;
    const snap = attachRuntime(value);
    const changed = mutate(snap);
    if (changed) writeSnapshot(snap);
    return changed;
  } finally {
    releaseLock(handle);
  }
}

export function rebuildVaultSnapshot(vaultRoot) {
  const notes = [];
  for (const dir of [...VAULT_DIRS, ...TITLE_INDEX_EXTRA_DIRS]) {
    const dirPath = join(vaultRoot, dir);
    try {
      const entries = readdirSync(dirPath, { recursive: true, withFileTypes: true });
      for (const e of entries) {
        if (!e.isFile()) continue;
        if (!e.name.endsWith('.md')) continue;
        const absParent = e.parentPath || dirPath;
        const abs = join(absParent, e.name);
        const rel = abs
          .slice(vaultRoot.length + 1)
          .split(sep)
          .join('/');
        notes.push({
          folder: dir,
          basename: basename(e.name, '.md'),
          rel_path: rel,
        });
      }
    } catch (err) {
      logError('snapshot.rebuildVaultSnapshot.readdir', err);
    }
  }
  const snap = {
    version: SNAPSHOT_VERSION,
    vault_root: vaultRoot,
    built_at: nowIso(),
    expires_at: expiresIso(),
    notes,
  };
  attachRuntime(snap);
  writeSnapshotLocked(snap);
  return snap;
}

export function loadVaultSnapshot(vaultRoot) {
  const path = snapshotPath();
  if (!path) return rebuildVaultSnapshot(vaultRoot);
  const { value: snap, error } = safeLoad(path);
  if (error || !snap) return rebuildVaultSnapshot(vaultRoot);
  if (snap.version !== SNAPSHOT_VERSION) return rebuildVaultSnapshot(vaultRoot);
  if (snap.vault_root !== vaultRoot) return rebuildVaultSnapshot(vaultRoot);
  if (Date.now() > Date.parse(snap.expires_at)) return rebuildVaultSnapshot(vaultRoot);
  return attachRuntime(snap);
}

export function maybeSplice(snap, newEntry) {
  if (!snap || !snap.relPathSet) return false;
  if (snap.relPathSet.has(newEntry.rel_path)) return false;
  snap.notes.push(newEntry);
  snap.relPathSet.add(newEntry.rel_path);
  snap.expires_at = expiresIso();
  lockedMutate((fresh) => {
    if (fresh.relPathSet.has(newEntry.rel_path)) return false;
    fresh.notes.push(newEntry);
    fresh.relPathSet.add(newEntry.rel_path);
    fresh.expires_at = snap.expires_at;
    return true;
  });
  return true;
}

export function removeFromSnapshot(snap, relPath) {
  if (!snap || !snap.relPathSet) return false;
  if (!snap.relPathSet.has(relPath)) return false;
  snap.notes = snap.notes.filter((n) => n.rel_path !== relPath);
  snap.relPathSet.delete(relPath);
  lockedMutate((fresh) => {
    if (!fresh.relPathSet.has(relPath)) return false;
    fresh.notes = fresh.notes.filter((n) => n.rel_path !== relPath);
    fresh.relPathSet.delete(relPath);
    return true;
  });
  return true;
}

// Build a basename-with-extension → absolute path Map for autolink.
// First-folder-wins iteration order: inbox-first, matching the historical
// buildNoteMap in hooks/post-write-autolink.js.
export function buildNoteMapFromSnapshot(snap, vaultRoot) {
  const map = new Map();
  const order = [...VAULT_DIRS, ...TITLE_INDEX_EXTRA_DIRS];
  const byFolder = new Map();
  for (const n of snap.notes) {
    if (!byFolder.has(n.folder)) byFolder.set(n.folder, []);
    byFolder.get(n.folder).push(n);
  }
  for (const folder of order) {
    const list = byFolder.get(folder);
    if (!list) continue;
    for (const n of list) {
      const key = basename(n.rel_path);
      if (!map.has(key)) {
        map.set(key, join(vaultRoot, ...n.rel_path.split('/')));
      }
    }
  }
  return map;
}

// Build a bare-basename → vault-relative path Map for edge classification.
// First-folder-wins iteration order: permanent-first, matching the historical
// buildVaultIndex in scripts/lib/edge-classifier.mjs.
export function buildVaultIndexFromSnapshot(snap) {
  const map = new Map();
  const byFolder = new Map();
  for (const n of snap.notes) {
    if (!byFolder.has(n.folder)) byFolder.set(n.folder, []);
    byFolder.get(n.folder).push(n);
  }
  for (const folder of EDGE_PRIORITY_DIRS) {
    const list = byFolder.get(folder);
    if (!list) continue;
    for (const n of list) {
      if (!map.has(n.basename)) {
        map.set(n.basename, n.rel_path);
      }
    }
  }
  return map;
}
