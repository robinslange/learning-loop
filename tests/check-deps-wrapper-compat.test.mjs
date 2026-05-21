import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('check-deps.mjs still emits the same top-level shape as before refactor', () => {
  // Smoke: run it, verify it returns valid JSON, expected fields present.
  const out = execFileSync('node', ['scripts/check-deps.mjs'], {
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

test('detectAbiDrift exported from impl module', async () => {
  const mod = await import('../scripts/check-deps-impl.mjs');
  assert.equal(typeof mod.detectAbiDrift, 'function');
  const r = mod.detectAbiDrift({ currentAbi: process.versions.modules });
  assert.ok(['ok', 'abi-mismatch', 'error'].includes(r.status));
});
