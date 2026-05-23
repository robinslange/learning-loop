// hooks/lib/common.mjs — Shared utilities for all learning-loop hooks
// Plugin-data resolution and the transient-path guard live in
// scripts/lib/config.mjs as the single source of truth; this module re-exports
// `resolvePluginData` for backward compatibility with hook callers.

import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, sep, dirname } from 'node:path';
import { homedir } from 'node:os';
import { resolvePluginData, getVaultPath } from '../../scripts/lib/config.mjs';
import { binaryPath } from '../../scripts/lib/binary.mjs';
import { appendJsonlLine } from '../../scripts/lib/jsonl.mjs';
import { env } from '../../scripts/lib/env.mjs';
import { safeLoad } from '../../scripts/lib/safe-load.mjs';
import { logError } from '../../scripts/lib/log.mjs';
import { getSessionId } from '../../scripts/lib/session.mjs';

export { resolvePluginData, getSessionId };
export const resolveVaultPath = getVaultPath;

export function home() {
  return env.HOME || env.USERPROFILE || homedir();
}

function readJsonStripBom(path) {
  let raw = readFileSync(path, 'utf-8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  return JSON.parse(raw);
}

export function resolveConfig() {
  const pluginData = resolvePluginData();
  if (pluginData) {
    try {
      return readJsonStripBom(join(pluginData, 'config.json'));
    } catch (err) {
      logError('common.resolveConfig.pluginData', err);
    }
  }
  try {
    return readJsonStripBom(join(resolve(import.meta.dirname, '..', '..'), 'config.json'));
  } catch (err) {
    logError('common.resolveConfig.fallback', err);
  }
  return {};
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

export function vaultRelPath(filePath, vaultPath) {
  const prefix = vaultPath + sep;
  if (filePath && filePath.startsWith(prefix)) {
    return filePath.slice(prefix.length);
  }
  return null;
}

export function isVaultNote(filePath, vaultRoot) {
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

export function readStdin() {
  return new Promise((res) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    const timeout = setTimeout(() => res(''), 3000);
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
  const pd = resolvePluginData();
  if (!pd) return;
  const dir = join(pd, 'provenance');
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
  const pd = resolvePluginData();
  if (!pd) return;
  const dir = join(pd, 'retrieval');
  mkdirSync(dir, { recursive: true });
  const record = {
    ts: new Date().toISOString(),
    session_id: getSessionId(),
    ...event,
  };
  appendJsonlLine(join(dir, `${prefix}-${monthStr()}.jsonl`), record);
}
