// scripts/check-deps-impl.mjs — pure logic for plugin-dependency checks.
// Extracted from scripts/check-deps.mjs so other modules can import the
// helpers without spawning a subprocess.

import { existsSync } from 'node:fs';
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

// Version pinned per Task 1.1 (YAGNI — no auto-discovery). Bump when episodic-memory ships a new native release.
export const NATIVE_PLUGINS = [
  {
    plugin: 'episodic-memory',
    nativeModulePath:
      (env.HOME || homedir()) +
      '/.claude/plugins/cache/superpowers-marketplace/episodic-memory/1.0.15/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
  },
];

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
  for (const { plugin, nativeModulePath } of NATIVE_PLUGINS) {
    if (!existsSync(nativeModulePath)) continue;
    const result = detectAbiDrift({ nativeModulePath, currentAbi: process.versions.modules });
    if (result.status !== 'ok') {
      entries.push({ plugin, ...result });
    }
  }
  return entries;
}
