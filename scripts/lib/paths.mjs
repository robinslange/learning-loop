import { sep, resolve, join } from 'path';
import { tmpdir, homedir } from 'os';
import { env } from './env.mjs';

export function home() {
  return env.HOME || env.USERPROFILE || homedir();
}

export function tmp() {
  return tmpdir();
}

export function toForwardSlash(p) {
  return sep === '\\' ? p.replace(/\\/g, '/') : p;
}

export function relativeToVault(fullPath, vaultPath) {
  const norm = resolve(fullPath);
  const base = resolve(vaultPath);
  if (!norm.startsWith(base)) return null;
  const rel = norm.slice(base.length);
  if (rel.length === 0) return '';
  if (rel[0] === sep || rel[0] === '/') return toForwardSlash(rel.slice(1));
  return null;
}

export function expandHome(raw) {
  return resolve(raw.replace(/^~/, home()));
}

export function tmpFile(name) {
  return join(tmp(), name);
}

// ─── Canonical PLUGIN_DATA paths ───────────────────────────────────────────
// Single source of truth for every subdirectory and file under PLUGIN_DATA.
// Call sites resolve through these functions — never construct paths inline.
// Adding a new path = adding one entry here. Renaming a folder = changing
// one line that every caller follows.
//
// Naming convention: the function name matches the leaf-most segment of the
// path, in camelCase. DATA_PATHS = directories under PLUGIN_DATA.
// FEDERATION_PATHS = the federation subtree (frequent enough to warrant its
// own namespace). DATA_FILES = standalone files directly under PLUGIN_DATA
// (no shared parent dir we want to name).

export const DATA_PATHS = {
  bin: (pd) => join(pd, 'bin'),
  convergence: (pd) => join(pd, 'convergence'),
  librarian: (pd) => join(pd, 'librarian'),
  librarianQueue: (pd) => join(pd, 'librarian', 'queue.jsonl'),
  retrieval: (pd) => join(pd, 'retrieval'),
  retrievalSessionDedupe: (pd) => join(pd, 'retrieval', 'session-dedupe'),
  provenance: (pd) => join(pd, 'provenance'),
  federation: (pd) => join(pd, 'federation'),
  sessionStartCache: (pd) => join(pd, 'session-start-cache'),
};

export const FEDERATION_PATHS = {
  root: (pd) => join(pd, 'federation'),
  config: (pd) => join(pd, 'federation', 'config.json'),
  seedMeta: (pd) => join(pd, 'federation', '.seed-meta.json'),
  seedNoticeShown: (pd) => join(pd, 'federation', '.seed-notice-shown'),
  outbox: (pd) => join(pd, 'federation', 'outbox'),
  peersDir: (pd) => join(pd, 'federation', 'data', 'peers'),
  peerDb: (pd, peerId) => join(pd, 'federation', 'data', 'peers', peerId, 'index.db'),
};

export const DATA_FILES = {
  edgesDb: (pd) => join(pd, 'edges.db'),
  nliSocket: (pd) => join(pd, 'nli.sock'),
  binVersion: (pd) => join(pd, 'bin', '.version'),
};
