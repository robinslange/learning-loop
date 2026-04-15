// hooks/lib/common.mjs — Shared utilities for all learning-loop hooks
// Single source of truth for plugin data resolution, session ID, vault path,
// stdin parsing, and retrieval/provenance emission.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';

export function home() {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

const DATA_PATH_MARKER = join(homedir(), '.claude', 'plugins', 'data', '.ll-data-path');

export function resolvePluginData() {
  const fromEnv = process.env.CLAUDE_PLUGIN_DATA;
  if (fromEnv) {
    try { writeFileSync(DATA_PATH_MARKER, fromEnv, 'utf-8'); } catch {}
    return fromEnv;
  }
  try {
    const saved = readFileSync(DATA_PATH_MARKER, 'utf-8').trim();
    if (saved && existsSync(saved)) return saved;
  } catch {}
  process.stderr.write('[learning-loop] CLAUDE_PLUGIN_DATA not set and no saved path found\n');
  return null;
}

function readJsonStripBom(path) {
  let raw = readFileSync(path, 'utf-8');
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  return JSON.parse(raw);
}

export function resolveConfig() {
  const pluginData = resolvePluginData();
  if (pluginData) {
    try {
      return readJsonStripBom(join(pluginData, 'config.json'));
    } catch {}
  }
  try {
    return readJsonStripBom(join(resolve(import.meta.dirname, '..', '..'), 'config.json'));
  } catch {}
  return {};
}

export function resolveVaultPath() {
  if (process.env.VAULT_PATH) return resolve(process.env.VAULT_PATH);
  const cfg = resolveConfig();
  if (cfg.vault_path) return resolve(cfg.vault_path.replace(/^~/, home()));
  return null;
}

export function binaryName() {
  return process.platform === 'win32' ? 'll-search.exe' : 'll-search';
}

export function findBinary() {
  const name = binaryName();
  const pluginData = resolvePluginData();
  if (pluginData) {
    const installed = join(pluginData, 'bin', name);
    if (existsSync(installed)) return { bin: installed, binDir: join(pluginData, 'bin') };
  }
  const devBuild = resolve(join(import.meta.dirname, '..', '..', 'native', 'target', 'release', name));
  if (existsSync(devBuild)) return { bin: devBuild, binDir: resolve(join(import.meta.dirname, '..', '..', 'native', 'target', 'release')) };
  return null;
}

export function findEpisodicBinary() {
  const claudeDir = join(home(), '.claude', 'plugins');
  const exe = process.platform === 'win32' ? '.exe' : '';
  try {
    const raw = JSON.parse(readFileSync(join(claudeDir, 'installed_plugins.json'), 'utf-8'));
    const plugins = raw.plugins || raw;
    for (const [key, entries] of Object.entries(plugins)) {
      if (!key.startsWith('episodic-memory@')) continue;
      const entry = entries[0];
      if (!entry?.installPath) continue;
      const bin = join(entry.installPath, 'cli', `episodic-memory${exe}`);
      if (existsSync(bin)) return bin;
    }
  } catch {}
  return null;
}

export function getSessionId() {
  try {
    return readFileSync(join(tmpdir(), 'learning-loop-session-id'), 'utf8').trim();
  } catch {
    return 'unknown';
  }
}

export function vaultRelPath(filePath, vaultPath) {
  const prefix = vaultPath + sep;
  if (filePath && filePath.startsWith(prefix)) {
    return filePath.slice(prefix.length);
  }
  return null;
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
  } catch {}
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
  appendFileSync(join(dir, `events-${monthStr()}.jsonl`), JSON.stringify(record) + '\n');
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
  appendFileSync(join(dir, `${prefix}-${monthStr()}.jsonl`), JSON.stringify(record) + '\n');
}
