import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { expandHome } from './paths.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DATA_PATH_MARKER = join(homedir(), '.claude', 'plugins', 'data', '.ll-data-path');

export function getPluginData() {
  const fromEnv = process.env.CLAUDE_PLUGIN_DATA;
  if (fromEnv) {
    try { writeFileSync(DATA_PATH_MARKER, fromEnv, 'utf-8'); } catch {}
    return fromEnv;
  }

  try {
    const saved = readFileSync(DATA_PATH_MARKER, 'utf-8').trim();
    if (saved && existsSync(saved)) return saved;
  } catch {}

  return join(homedir(), '.claude', 'plugins', 'data', 'learning-loop');
}

export function getPluginRoot() {
  return resolve(join(__dirname, '..', '..'));
}

function configPath() {
  return join(getPluginData(), 'config.json');
}

function legacyConfigPath() {
  return join(getPluginRoot(), 'config.json');
}

let _config = null;

export function getConfig() {
  if (_config) return _config;

  const primary = configPath();
  const legacy = legacyConfigPath();

  if (existsSync(primary)) {
    try {
      _config = JSON.parse(readFileSync(primary, 'utf-8'));
      return _config;
    } catch { /* fall through */ }
  }

  if (existsSync(legacy)) {
    try {
      _config = JSON.parse(readFileSync(legacy, 'utf-8'));
      migrateConfig(legacy, primary);
      return _config;
    } catch { /* fall through */ }
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
  const raw = process.env.VAULT_PATH || cfg.vault_path || '~/brain/brain';
  return expandHome(raw);
}
