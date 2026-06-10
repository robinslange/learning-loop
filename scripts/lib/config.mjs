import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir, tmpdir } from 'os';
import { expandHome } from './paths.mjs';
import { safeLoad } from './safe-load.mjs';
import { env } from './env.mjs';
import { logError } from './log.mjs';

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
  } catch (err) {
    logError('config.persistMarker', err);
  }
}

export function getPluginData() {
  // eslint-disable-next-line learning-loop/no-process-env-outside-env-module
  const fromEnv = process.env.CLAUDE_PLUGIN_DATA;
  if (fromEnv) {
    persistMarker(fromEnv);
    return fromEnv;
  }

  // A missing marker is the expected no-plugin-data case (CLI, cron, tests) —
  // not an error. getSessionId() now calls this on a hot path, so only log/warn
  // when the marker EXISTS but can't be read (perms, IO); stay silent otherwise.
  if (existsSync(DATA_PATH_MARKER)) {
    try {
      const saved = readFileSync(DATA_PATH_MARKER, 'utf-8').trim();
      if (saved && existsSync(saved)) return saved;
    } catch (err) {
      logError('config.getPluginData', err);
    }
    process.stderr.write('[learning-loop] CLAUDE_PLUGIN_DATA not set and no saved path found\n');
  }

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
    } catch (err) {
      logError('config.getConfig.primary', err);
    }
  }

  if (existsSync(legacy)) {
    try {
      _config = readJsonStripBom(legacy);
      if (primary) migrateConfig(legacy, primary);
      return _config;
    } catch (err) {
      logError('config.getConfig.legacy', err);
    }
  }

  _config = {};
  return _config;
}

/**
 * Like getConfig(), but a config file that EXISTS and cannot be read/parsed
 * throws instead of silently returning {}. Gates that weaken when config is
 * missing (harvest deny terms) must use this: swallow-and-default is a
 * fail-open for them. A genuinely absent config still returns {}.
 *
 * Deliberately stricter than getConfig: a corrupt primary does NOT fall
 * through to a readable legacy (resurrecting a stale legacy config is itself
 * a fail-open), and the _config cache is never used (gates want on-disk truth).
 */
export function getConfigStrict() {
  const primary = configPath();
  const legacy = legacyConfigPath();
  for (const p of [primary, legacy]) {
    if (!p || !existsSync(p)) continue;
    const { value, error } = safeLoad(p);
    if (error) throw new Error(`config unreadable at ${p}: ${error}`);
    return value ?? {};
  }
  return {};
}

/**
 * Drop the cached config so the next getConfig() call re-reads from disk.
 *
 * Two legitimate uses:
 * 1. Tests that mutate the config file between assertions.
 * 2. Callers that detect a config-file change via their own mtime/inode tracking
 *    (e.g. scripts/librarian/config.mjs) and need the underlying getConfig
 *    cache to follow. Without this, that caller's own cache invalidates but
 *    the canonical cache returns the stale object forever.
 */
export function resetConfigCache() {
  _config = null;
}

function migrateConfig(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  process.stderr.write(`[config] Migrated config to ${to}\n`);
}

export function getVaultPath() {
  const cfg = getConfig();
  // eslint-disable-next-line learning-loop/no-process-env-outside-env-module
  const raw = process.env.VAULT_PATH || cfg.vault_path;
  if (!raw) return null;
  return expandHome(raw);
}
