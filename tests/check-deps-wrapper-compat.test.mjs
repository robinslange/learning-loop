import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('check-deps.mjs still emits the same top-level shape as before refactor', () => {
  // Smoke: run it, verify it returns valid JSON, expected fields present.
  const out = execFileSync('node', ['plugin/scripts/check-deps.mjs'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const obj = JSON.parse(out);
  assert.equal(typeof obj, 'object');
  assert.ok(Array.isArray(obj._abi_drift), '_abi_drift must be an array');
  // Plugin entries should have status, marketplace, required fields (when any deps configured)
  for (const k of Object.keys(obj)) {
    if (k === '_abi_drift') continue;
    const v = obj[k];
    assert.ok('status' in v, `${k} missing status`);
    assert.ok('marketplace' in v, `${k} missing marketplace`);
    assert.ok('required' in v, `${k} missing required`);
  }
});

test('check-deps reads config from PLUGIN_DATA, not just the plugin root', () => {
  // Regression: check-deps used to load PLUGIN_DIR/config.json directly, so an
  // install whose config lives only at PLUGIN_DATA/config.json got an empty
  // dependency report with exit 0: dependency checking silently off.
  const dataDir = mkdtempSync(join(tmpdir(), 'check-deps-data-'));
  try {
    writeFileSync(
      join(dataDir, 'config.json'),
      JSON.stringify({
        dependencies: [
          { name: 'primary-only-dep', marketplace: 'nowhere', required: true, version: '>=1.0.0' },
        ],
      }),
    );
    const out = execFileSync('node', ['plugin/scripts/check-deps.mjs'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
    });
    const obj = JSON.parse(out);
    assert.ok(
      'primary-only-dep' in obj,
      'dependency declared only in PLUGIN_DATA/config.json must be reported',
    );
    assert.equal(obj['primary-only-dep'].status, 'missing');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('detectAbiDrift exported from impl module', async () => {
  const mod = await import('../plugin/scripts/check-deps-impl.mjs');
  assert.equal(typeof mod.detectAbiDrift, 'function');
  const r = mod.detectAbiDrift({ currentAbi: process.versions.modules });
  assert.ok(['ok', 'abi-mismatch', 'error'].includes(r.status));
});
