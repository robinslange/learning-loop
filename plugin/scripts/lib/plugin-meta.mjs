// scripts/lib/plugin-meta.mjs : plugin self-introspection helpers.
//
// Centralises the plugin-manifest + plugin-root + plugin-data lookups that today
// appear inline in hooks/session-start.js (lines 37, 71), scripts/lib/config.mjs
// (getPluginRoot), and hooks/lib/inject.mjs. Reads from scripts/lib/env.mjs
// rather than process.env directly -- this is the canonical example of how a
// new primitive should consume the env module.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from './env.mjs';
import { safeLoad } from './safe-load.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const PLUGIN_NAME = 'learning-loop';
export const MARKETPLACE_NAME = 'learning-loop-marketplace';

/** Key of this plugin's entry in ~/.claude/plugins/installed_plugins.json. */
export const INSTALL_KEY = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;

// Claude Code names CLAUDE_PLUGIN_DATA after the install id, with every
// character outside [A-Za-z0-9_-] replaced by '-'.
export const DATA_DIR_NAME = INSTALL_KEY.replace(/[^A-Za-z0-9_-]/g, '-');

/** Where Claude Code ('.claude') or Codex ('.codex') caches installed versions. */
export const cacheRoot = (home, dot) =>
  join(home, dot, 'plugins', 'cache', MARKETPLACE_NAME, PLUGIN_NAME);

let _pkg = null;

function readPkg() {
  if (_pkg !== null) return _pkg;
  const path = join(pluginRoot(), '.claude-plugin', 'plugin.json');
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
 * Version string from .claude-plugin/plugin.json, or empty string on read failure.
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
  return `${pkg.name || PLUGIN_NAME}@${pkg.version || ''}`;
}

/**
 * Root of the install Claude Code has active, when that install ships `need`.
 *
 * A running session stays pinned to the version directory it loaded, while the
 * installed_plugins.json entry moves the moment a newer version installs.
 * Following the entry lets an open session run the newest code without a
 * reload. It only wins when it sits next to `selfRoot` in the same cache
 * directory, which keeps a Codex install, a --plugin-dir checkout and a test
 * fixture running themselves, and when it still ships `need`, so a session
 * keeps a hook the new version removed.
 *
 * @param {{ need: string, selfRoot?: string, home?: string }} opts
 * @returns {string}
 */
export function activeRoot({ need, selfRoot = pluginRoot(), home = env.HOME }) {
  const { value } = safeLoad(join(home, '.claude', 'plugins', 'installed_plugins.json'));
  const installed = (value?.plugins ?? value)?.[INSTALL_KEY]?.[0]?.installPath;
  if (installed && dirname(installed) === dirname(selfRoot) && existsSync(join(installed, need))) {
    return installed;
  }
  return selfRoot;
}
