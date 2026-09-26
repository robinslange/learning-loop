#!/usr/bin/env node
// scripts/check-deps.mjs — plugin dependency reporter.
// As a CLI it prints one JSON object: an entry per configured dependency plus
// `_abi_drift` (the session-start hook and init Phase 3 read that shape). As a
// module it exports the ABI-drift helpers the health checks use.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { env } from './lib/env.mjs';
import { safeLoad } from './lib/safe-load.mjs';
import { getConfig } from './lib/config.mjs';
import { semverCmp } from './lib/semver.mjs';
import { isMainModule } from './lib/is-main.mjs';

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

export function newestVersionDir(baseDir) {
  if (!existsSync(baseDir)) return null;
  const dirs = readdirSync(baseDir).filter((d) => /^\d+\.\d+\.\d+$/.test(d));
  return dirs.sort(semverCmp).at(-1) ?? null;
}

function getNativePlugins({ home = env.HOME || homedir() } = {}) {
  const base = home + '/.claude/plugins/cache/superpowers-marketplace/episodic-memory';
  const ver = newestVersionDir(base);
  if (!ver) return [];
  return [
    {
      plugin: 'episodic-memory',
      nativeModulePath: `${base}/${ver}/node_modules/better-sqlite3/build/Release/better_sqlite3.node`,
    },
  ];
}

// Only `>=X.Y.Z` constraints are checked; anything else is satisfied.
function satisfiesVersion(installed, constraint) {
  if (!constraint || !installed) return true;
  const match = constraint.match(/^>=\s*(\d+\.\d+\.\d+)$/);
  if (!match) return true;
  return semverCmp(installed, match[1]) >= 0;
}

function buildAbiDrift() {
  const entries = [];
  for (const { plugin, nativeModulePath } of getNativePlugins()) {
    if (!existsSync(nativeModulePath)) continue;
    const result = detectAbiDrift({ nativeModulePath, currentAbi: process.versions.modules });
    if (result.status !== 'ok') {
      entries.push({ plugin, ...result });
    }
  }
  return entries;
}

/**
 * The single abi-drift verdict a health check reports.
 *
 * Callers used to reduce buildAbiDrift() themselves, and health-check.mjs
 * instead called detectAbiDrift() with no module path — which probes nothing
 * and returns `ok` unconditionally, so `/doctor` reported "no drift" on a
 * machine that had it.
 *
 * @returns {{status: string, [k: string]: unknown}}
 */
export function abiDriftSummary() {
  const entries = buildAbiDrift();
  return entries.length > 0 ? entries[0] : { status: 'ok' };
}

if (isMainModule(import.meta.url)) {
  const INSTALLED_PATH = join(
    env.HOME || env.USERPROFILE || homedir(),
    '.claude',
    'plugins',
    'installed_plugins.json',
  );

  const deps = getConfig().dependencies || [];
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
