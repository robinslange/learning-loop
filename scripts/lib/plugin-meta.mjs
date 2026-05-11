// scripts/lib/plugin-meta.mjs : plugin self-introspection helpers.
//
// Centralises the package.json + plugin-root + plugin-data lookups that today
// appear inline in hooks/session-start.js (lines 37, 71), scripts/lib/config.mjs
// (getPluginRoot), and hooks/lib/inject.mjs. Reads from scripts/lib/env.mjs
// rather than process.env directly -- this is the canonical example of how a
// new primitive should consume the env module.
//
// config.mjs already exports getPluginRoot() and getPluginData(). Those stay
// unchanged in phase 0; consumers migrate in phase 1I. The two co-exist.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { env } from './env.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

let _pkg = null;

function readPkg() {
  if (_pkg !== null) return _pkg;
  const path = join(pluginRoot(), 'package.json');
  try {
    let raw = readFileSync(path, 'utf-8');
    // Strip BOM if present.
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    _pkg = JSON.parse(raw);
  } catch {
    _pkg = {};
  }
  return _pkg;
}

/**
 * Absolute path to the plugin checkout root.
 * Derived from this file's location: scripts/lib/plugin-meta.mjs -> ../../
 *
 * @returns {string}
 */
export function pluginRoot() {
  return resolve(join(__dirname, '..', '..'));
}

/**
 * Version string from package.json, or empty string on read failure.
 *
 * @returns {string}
 */
export function pluginVersion() {
  return readPkg().version || '';
}

/**
 * Plugin identifier in `name@version` format. Used in log/telemetry scopes.
 *
 * @returns {string}
 */
export function pluginId() {
  const pkg = readPkg();
  return `${pkg.name || 'learning-loop'}@${pkg.version || ''}`;
}

/**
 * Plugin-data directory. Uses `CLAUDE_PLUGIN_DATA` env var when set, falling
 * back to `~/.claude/plugins/data/learning-loop`. Returns null only when no
 * home directory can be resolved and CLAUDE_PLUGIN_DATA is unset.
 *
 * @returns {string | null}
 */
export function dataDir() {
  if (env.CLAUDE_PLUGIN_DATA) return env.CLAUDE_PLUGIN_DATA;
  const home = env.HOME || homedir();
  if (!home) return null;
  return join(home, '.claude', 'plugins', 'data', 'learning-loop');
}

/**
 * Plugin cache directory under dataDir().
 * Returns null when dataDir() returns null.
 *
 * @returns {string | null}
 */
export function cacheDir() {
  const d = dataDir();
  return d ? join(d, 'cache') : null;
}
