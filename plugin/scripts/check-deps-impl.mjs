// scripts/check-deps-impl.mjs — pure logic for plugin-dependency checks.
// Extracted from scripts/check-deps.mjs so other modules can import the
// helpers without spawning a subprocess.

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { env } from './lib/env.mjs';

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
  if (dirs.length === 0) return null;
  dirs.sort((a, b) => {
    const [a1, a2, a3] = a.split('.').map(Number);
    const [b1, b2, b3] = b.split('.').map(Number);
    return a1 - b1 || a2 - b2 || a3 - b3;
  });
  return dirs[dirs.length - 1];
}

export function getNativePlugins({ home = env.HOME || homedir() } = {}) {
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

export function satisfiesVersion(installed, constraint) {
  if (!constraint || !installed) return true;
  const match = constraint.match(/^>=\s*(\d+\.\d+\.\d+)$/);
  if (!match) return true;
  const [reqMajor, reqMinor, reqPatch] = match[1].split('.').map(Number);
  const [insMajor, insMinor, insPatch] = installed.split('.').map(Number);
  if (insMajor !== reqMajor) return insMajor > reqMajor;
  if (insMinor !== reqMinor) return insMinor > reqMinor;
  return insPatch >= reqPatch;
}

export function buildAbiDrift() {
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
