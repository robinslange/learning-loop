import { sep, resolve, join, relative, isAbsolute } from 'path';
import { tmpdir, homedir } from 'os';
import { env } from './env.mjs';

export function home() {
  return env.HOME || env.USERPROFILE || homedir();
}

// Encode a project directory into its ~/.claude/projects/<slug> segment.
// Claude Code replaces every path separator AND every '.' and ':' with '-',
// so /Users/x/.claude/p -> -Users-x--claude-p and C:\Users\x -> C--Users-x.
// The ':' replacement is load-bearing on Windows: a drive colon left in the
// slug is an illegal filename char and mkdir fails. Match CC exactly so we
// resolve the dir CC actually created.
export function encodeProjectDir(projectDir) {
  return projectDir.replace(/[/\\.:]/g, '-');
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

// Resolve a caller-supplied relative path against the vault root, returning the
// absolute path ONLY if it stays inside. The inverse of relativeToVault.
//
// existsSync() is not a containment check and must never be used as one: a
// traversal like '../../.zshrc' names a file that genuinely exists, so an
// existence guard passes it straight through. Callers that take a path from an
// LLM tool call, a note body, or any other untrusted source must resolve
// through here first.
//
// Returns null for: a non-string, an absolute path, a traversal that escapes,
// or the vault root itself. Extension filtering is the caller's job — a
// librarian reading notes should also require '.md'.
export function resolveInVault(relPath, vaultPath) {
  if (typeof relPath !== 'string' || !relPath || !vaultPath) return null;
  if (isAbsolute(relPath)) return null;
  const base = resolve(vaultPath);
  const full = resolve(base, relPath);
  const rel = relative(base, full);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return full;
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
  // /reflect Step 4 session-keyed scratch markers (new-notes list, refinement
  // pair/agent/validated JSON, sweep candidates). Anchored in plugin-data — NOT
  // tmp — so the hook subprocess and the skill's bash resolve the SAME dir
  // regardless of whether each inherits $TMPDIR (os.tmpdir() honors $TMPDIR, so
  // a tmp anchor diverges between a hook subprocess and the interactive shell).
  reflectScratch: (pd) => join(pd, 'reflect-scratch'),
  // Env-independent session-id anchor. SessionStart stamps the canonical id
  // (the harness $CLAUDE_CODE_SESSION_ID) into session/id; getSessionId() reads
  // the env var first, then this file. Earlier revisions keyed per-process files
  // here (id-<ppid>), but ppid is not a session key — it differs per process and
  // the stale files shadowed the real id — so the single unsuffixed file is all
  // that remains.
  session: (pd) => join(pd, 'session'),
  // Dream/reflect handshake markers (last-reflect, dream-lock, dream-nudged,
  // memory-snapshot-<sid>). Session-scoped; the SessionStart TTL sweep reaps
  // anything older than 7 days. last-dream is NOT here — it must persist
  // (the 24h dream gate compares against it) and existing installs already
  // carry it under retrieval/, so it stays there (see MARKER_PATHS.lastDream).
  markers: (pd) => join(pd, 'markers'),
  provenance: (pd) => join(pd, 'provenance'),
  federation: (pd) => join(pd, 'federation'),
  sessionStartCache: (pd) => join(pd, 'session-start-cache'),
  dreamEval: (pd) => join(pd, 'dream-eval'),
  dreamEvalProbes: (pd) => join(pd, 'dream-eval', 'probes.jsonl'),
  dreamEvalReports: (pd) => join(pd, 'dream-eval', 'reports'),
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
  nliSocket: (pd) => join(pd, 'nli.sock'), // legacy filename — now serves duplicate-scan only
  binVersion: (pd) => join(pd, 'bin', '.version'),
  harvestDenylist: (pd) => join(pd, '.harvest-denylist'),
  harvestedLog: (pd) => join(pd, '.harvested-log'),
};
