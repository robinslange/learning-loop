#!/usr/bin/env node
// Checks plugin dependencies declared in config.json against installed_plugins.json.
// Returns JSON: { "plugin-name": { status, installed, versionConstraint, marketplace, reason, required, tools }, _abi_drift: [] }

import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { env } from './lib/env.mjs';
import { logError } from './lib/log.mjs';
import { safeLoad } from './lib/safe-load.mjs';

const _require = createRequire(import.meta.url);

export function detectAbiDrift({ nativeModulePath, currentAbi, fakeLoadError } = {}) {
  let err = fakeLoadError ?? null;
  if (err === null && nativeModulePath !== null && nativeModulePath !== undefined) {
    try {
      _require(nativeModulePath);
    } catch (e) {
      err = e;
    }
  }
  if (err === null) return { status: 'ok' };
  const msg = err.message || '';
  const match = msg.match(/NODE_MODULE_VERSION (\d+)[\s\S]*?NODE_MODULE_VERSION (\d+)/);
  if (match) {
    const expectedAbi = match[1];
    const actualAbi = currentAbi || match[2];
    const dir = nativeModulePath ? nativeModulePath.replace(/\/node_modules\/.*/u, '/') : '';
    return {
      status: 'abi-mismatch',
      expectedAbi,
      actualAbi,
      fix: `Run \`npm rebuild\` in ${dir}`,
    };
  }
  return { status: 'error', message: msg };
}

// Version pinned per Task 1.1 (YAGNI — no auto-discovery). Bump when episodic-memory ships a new native release.
const NATIVE_PLUGINS = [
  {
    plugin: 'episodic-memory',
    nativeModulePath:
      (env.HOME || homedir()) +
      '/.claude/plugins/cache/superpowers-marketplace/episodic-memory/1.0.15/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
  },
];

function satisfiesVersion(installed, constraint) {
  if (!constraint || !installed) return true;
  const match = constraint.match(/^>=\s*(\d+\.\d+\.\d+)$/);
  if (!match) return true;
  const [reqMajor, reqMinor, reqPatch] = match[1].split('.').map(Number);
  const [insMajor, insMinor, insPatch] = installed.split('.').map(Number);
  if (insMajor !== reqMajor) return insMajor > reqMajor;
  if (insMinor !== reqMinor) return insMinor > reqMinor;
  return insPatch >= reqPatch;
}

function buildAbiDrift() {
  const entries = [];
  for (const { plugin, nativeModulePath } of NATIVE_PLUGINS) {
    if (!existsSync(nativeModulePath)) continue;
    const result = detectAbiDrift({ nativeModulePath, currentAbi: process.versions.modules });
    if (result.status !== 'ok') {
      entries.push({ plugin, ...result });
    }
  }
  return entries;
}

const isMain = import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isMain) {
  const PLUGIN_DIR = resolve(import.meta.dirname, '..');
  const CONFIG_PATH = join(PLUGIN_DIR, 'config.json');
  const INSTALLED_PATH = join(
    env.HOME || env.USERPROFILE || homedir(),
    '.claude',
    'plugins',
    'installed_plugins.json',
  );

  const { value: config, error: configError } = safeLoad(CONFIG_PATH, { fallback: null });
  if (configError || !config) {
    process.stdout.write(JSON.stringify({ _abi_drift: buildAbiDrift() }));
    process.exit(0);
  }

  const deps = config.dependencies || [];
  if (deps.length === 0) {
    process.stdout.write(JSON.stringify({ _abi_drift: buildAbiDrift() }));
    process.exit(0);
  }

  const { value: rawInstalled } = safeLoad(INSTALLED_PATH, { fallback: {} });
  const installed = rawInstalled?.plugins || rawInstalled || {};

  const result = {};

  for (const dep of deps) {
    const key = `${dep.name}@${dep.marketplace}`;
    const entries = installed[key];
    const base = {
      versionConstraint: dep.version || null,
      marketplace: dep.marketplace,
      reason: dep.reason || null,
      required: !!dep.required,
      tools: dep.tools || [],
    };

    if (!entries || entries.length === 0) {
      result[dep.name] = { status: 'missing', installed: null, ...base };
      continue;
    }

    const entry = entries[0];
    const version = entry.version || 'unknown';

    if (!satisfiesVersion(version, dep.version)) {
      result[dep.name] = { status: 'outdated', installed: version, ...base };
      continue;
    }

    result[dep.name] = { status: 'installed', installed: version, ...base };
  }

  process.stdout.write(JSON.stringify({ ...result, _abi_drift: buildAbiDrift() }));
}
