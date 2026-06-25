// hooks/lib/common.mjs — Shared utilities for all learning-loop hooks
// Plugin-data resolution and the transient-path guard live in
// scripts/lib/config.mjs as the single source of truth; this module re-exports
// `resolvePluginData` for backward compatibility with hook callers.

import {
  mkdirSync,
  existsSync,
  appendFileSync,
  openSync,
  readSync,
  closeSync,
  fstatSync,
} from 'node:fs';
import { join, sep, dirname } from 'node:path';
import { homedir } from 'node:os';
import {
  resolvePluginData,
  getVaultPath,
  getConfig,
  pluginDataExists,
} from '../../scripts/lib/config.mjs';
import { binaryPath } from '../../scripts/lib/binary.mjs';
import { appendJsonlLine } from '../../scripts/lib/jsonl.mjs';
import { env } from '../../scripts/lib/env.mjs';
import { safeLoad } from '../../scripts/lib/safe-load.mjs';
import { HookConfig } from '../../scripts/lib/hook-config.mjs';
import { logError } from '../../scripts/lib/log.mjs';
import { getSessionId } from '../../scripts/lib/session.mjs';
import { writeRetrieval } from '../../scripts/lib/retrieval.mjs';
import { DATA_PATHS, toForwardSlash } from '../../scripts/lib/paths.mjs';

export { resolvePluginData, getSessionId };
export const resolveVaultPath = getVaultPath;
export const resolveConfig = getConfig;

export function home() {
  return env.HOME || env.USERPROFILE || homedir();
}

export function binaryName() {
  return process.platform === 'win32' ? 'll-search.exe' : 'll-search';
}

export function findBinary() {
  const bin = binaryPath();
  if (!bin) return null;
  return { bin, binDir: dirname(bin) };
}

export function findEpisodicBinary() {
  const claudeDir = join(home(), '.claude', 'plugins');
  const exe = process.platform === 'win32' ? '.exe' : '';
  const { value: raw } = safeLoad(join(claudeDir, 'installed_plugins.json'), { fallback: null });
  if (!raw) return null;
  try {
    const plugins = raw.plugins || raw;
    for (const [key, entries] of Object.entries(plugins)) {
      if (!key.startsWith('episodic-memory@')) continue;
      const entry = entries[0];
      if (!entry?.installPath) continue;
      const bin = join(entry.installPath, 'cli', `episodic-memory${exe}`);
      if (existsSync(bin)) return bin;
    }
  } catch (err) {
    logError('common.findEpisodicBinary', err);
  }
  return null;
}

// Test seam: when LL_CHILD_PID_FILE is set (hook-runner sandboxes), record
// every detached child pid so the harness can reap them before it removes
// the sandbox — a child mkdir-ing mid-rmSync-walk resurrects just-deleted
// dirs and fails cleanup with ENOTEMPTY. No-op in production (var unset).
export function recordDetachedChild(pid) {
  const file = env.LL_CHILD_PID_FILE;
  if (!file || !pid) return;
  try {
    appendFileSync(file, `${pid}\n`);
    // eslint-disable-next-line learning-loop/no-empty-catch
  } catch {
    // Best-effort: a lost record only means the harness can't reap early.
  }
}

export function vaultRelPath(filePath, vaultPath) {
  const prefix = vaultPath + sep;
  if (filePath && filePath.startsWith(prefix)) {
    return toForwardSlash(filePath.slice(prefix.length));
  }
  return null;
}

export function isVaultNote(filePath, vaultRoot) {
  if (!filePath) return false;
  const prefix = vaultRoot + sep;
  if (!filePath.startsWith(prefix)) return false;
  if (!filePath.endsWith('.md')) return false;
  const rel = filePath.slice(prefix.length);
  const firstSegment = rel.split(sep)[0];
  if (firstSegment.startsWith('_') || firstSegment.startsWith('.')) return false;
  return true;
}

export function classifyVaultPath(relPath) {
  const p = relPath.replace(/\\/g, '/');
  if (p.startsWith('0-inbox/')) return 'inbox';
  if (p.startsWith('1-fleeting/')) return 'fleeting';
  if (p.startsWith('2-literature/')) return 'literature';
  if (p.startsWith('3-permanent/')) return 'permanent';
  if (p.startsWith('4-projects/')) return 'project';
  if (p.startsWith('5-maps/')) return 'map';
  if (p.startsWith('_system/')) return 'system';
  return 'other';
}

// Read at most the last maxBytes of a file as UTF-8 text. When the read
// starts mid-file, everything up to and including the first newline is
// dropped: the leading fragment is an incomplete line (and may start on a
// broken multi-byte boundary). Lets per-prompt hooks consume the tail of
// multi-MB transcripts at O(maxBytes) cost instead of reading the whole file.
export function readFileTail(path, maxBytes) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl === -1 ? '' : text.slice(nl + 1);
    }
    return text;
  } finally {
    closeSync(fd);
  }
}

export function readStdin() {
  return new Promise((res) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    const timeout = setTimeout(() => res(''), HookConfig.STDIN_TIMEOUT_MS);
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => {
      clearTimeout(timeout);
      res(data);
    });
  });
}

// Run a PostToolUse hook: read stdin, parse JSON, call handler with
// { tool, input, response, raw }. Swallows errors silently.
export async function runHook(handler) {
  try {
    const raw = JSON.parse(await readStdin());
    await handler({
      tool: raw.tool_name,
      input: raw.tool_input || {},
      response: raw.tool_response,
      raw,
    });
  } catch (err) {
    logError('common.runHook', err);
  }
}

// --- Emission helpers ---

function monthStr() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

const provenanceDedupeKeys = new Set();

export function emitProvenance(event) {
  const key = `${event.session_id || ''}|${event.agent_id || ''}|${event.path || ''}`;
  if (key !== '||' && provenanceDedupeKeys.has(key)) return;
  provenanceDedupeKeys.add(key);
  if (!pluginDataExists()) return;
  const pd = resolvePluginData();
  if (!pd) return;
  const dir = DATA_PATHS.provenance(pd);
  mkdirSync(dir, { recursive: true });
  const record = {
    ts: new Date().toISOString(),
    session_id: getSessionId(),
    source: 'hook',
    ...event,
  };
  appendJsonlLine(join(dir, `events-${monthStr()}.jsonl`), record);
}

export function emitRetrieval(prefix, event) {
  // Thin adapter: delegate the canonical record shape to lib/retrieval.
  // event.type was the old "what kind of event" field — map it to the
  // canonical `command`. event.file (for memory-read events) is treated
  // as the `query` slot when no real query is present. event itself
  // becomes meta so any caller-specific fields (tool, session_label,
  // prompt, etc.) survive on the record.
  //
  // RESERVED KEYS — meta is spread AFTER the canonical fields in the
  // writer, so an event passing any of these would override the writer's
  // computed value silently: ts, session_id, command, query, result_count,
  // peer_results, top_paths. Audit before adding new keys to any hook
  // caller. Today no caller passes any of these; if you need to, do it
  // via the explicit slot (e.g. `query: ...`) rather than through event.
  writeRetrieval({
    pluginData: resolvePluginData(),
    prefix,
    command: event.type || event.command || prefix,
    query: event.query || event.file || '',
    results: event.results || null,
    meta: event,
  });
}
