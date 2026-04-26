import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir, tmpdir } from 'os';
import { expandHome } from './paths.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DATA_PATH_MARKER = join(homedir(), '.claude', 'plugins', 'data', '.ll-data-path');

// True if `p` looks like a transient/test path. We never stamp these into the
// marker file: tests set CLAUDE_PLUGIN_DATA to a temp dir, and a write-on-read
// stomp would persist a path that vanishes when the test cleans up — breaking
// shell-only ll-search invocations until the next real session re-stamps.
export function isTransientPath(p) {
  if (!p) return true;
  const tmp = tmpdir();
  return (
    p.startsWith(tmp) ||
    p.startsWith('/tmp/') ||
    p.startsWith('/var/folders/') ||
    p.startsWith('/private/var/folders/')
  );
}

function persistMarker(p) {
  if (isTransientPath(p)) return;
  try {
    if (existsSync(DATA_PATH_MARKER)) {
      const current = readFileSync(DATA_PATH_MARKER, 'utf-8').trim();
      if (current === p) return;
    }
    writeFileSync(DATA_PATH_MARKER, p, 'utf-8');
  } catch {}
}

export function getPluginData() {
  const fromEnv = process.env.CLAUDE_PLUGIN_DATA;
  if (fromEnv) {
    persistMarker(fromEnv);
    return fromEnv;
  }

  try {
    const saved = readFileSync(DATA_PATH_MARKER, 'utf-8').trim();
    if (saved && existsSync(saved)) return saved;
  } catch {}

  process.stderr.write('[learning-loop] CLAUDE_PLUGIN_DATA not set and no saved path found\n');
  return null;
}

// Alias retained for hooks/lib/common.mjs compatibility — same function,
// historical naming difference.
export const resolvePluginData = getPluginData;

function readJsonStripBom(path) {
  let raw = readFileSync(path, 'utf-8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  return JSON.parse(raw);
}

export function getPluginRoot() {
  return resolve(join(__dirname, '..', '..'));
}

function configPath() {
  const pd = getPluginData();
  return pd ? join(pd, 'config.json') : null;
}

function legacyConfigPath() {
  return join(getPluginRoot(), 'config.json');
}

let _config = null;

export function getConfig() {
  if (_config) return _config;

  const primary = configPath();
  const legacy = legacyConfigPath();

  if (primary && existsSync(primary)) {
    try {
      _config = readJsonStripBom(primary);
      return _config;
    } catch {
      /* fall through */
    }
  }

  if (existsSync(legacy)) {
    try {
      _config = readJsonStripBom(legacy);
      if (primary) migrateConfig(legacy, primary);
      return _config;
    } catch {
      /* fall through */
    }
  }

  _config = {};
  return _config;
}

function migrateConfig(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  process.stderr.write(`[config] Migrated config to ${to}\n`);
}

export function getVaultPath() {
  const cfg = getConfig();
  const raw = process.env.VAULT_PATH || cfg.vault_path;
  if (!raw) return null;
  return expandHome(raw);
}
