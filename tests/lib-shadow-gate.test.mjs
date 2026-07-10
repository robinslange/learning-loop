import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isVaultOk,
  isEpisodicOk,
  isHealthy,
  isGatePassed,
  SHADOW_BACKEND_HEALTH_MIN_RATE,
  SHADOW_BACKEND_HEALTH_MIN_TOTAL,
} from '../plugin/scripts/lib/shadow-gate.mjs';

test('isVaultOk: true unless the vault backend recorded an error', () => {
  assert.equal(isVaultOk({ backends: { vault: {} } }), true);
  assert.equal(isVaultOk({ backends: { vault: { error: 'boom' } } }), false);
  // Missing structure at every level is treated as ok (no recorded error) and
  // must never throw — each ?. link is load-bearing.
  assert.equal(isVaultOk({ backends: {} }), true); // no vault key
  assert.equal(isVaultOk({}), true); // no backends key
  assert.equal(isVaultOk(null), true);
  assert.equal(isVaultOk(undefined), true);
});

test('isEpisodicOk: true unless the episodic backend recorded an error', () => {
  assert.equal(isEpisodicOk({ backends: { episodic: {} } }), true);
  assert.equal(isEpisodicOk({ backends: { episodic: { error: 'boom' } } }), false);
  assert.equal(isEpisodicOk({ backends: {} }), true); // no episodic key
  assert.equal(isEpisodicOk({}), true);
  assert.equal(isEpisodicOk(null), true);
});

test('isHealthy requires no fast-path skip AND both backends ok', () => {
  const ok = { gate: { fast_path_skip: false }, backends: { vault: {}, episodic: {} } };
  assert.equal(isHealthy(ok), true);

  // fast-path skip => not healthy, even with both backends ok.
  assert.equal(isHealthy({ ...ok, gate: { fast_path_skip: true } }), false);

  // Either backend erroring => not healthy.
  assert.equal(isHealthy({ gate: {}, backends: { vault: { error: 'x' }, episodic: {} } }), false);
  assert.equal(isHealthy({ gate: {}, backends: { vault: {}, episodic: { error: 'x' } } }), false);

  // A missing gate object must not throw — the ?. on gate is load-bearing.
  assert.equal(isHealthy({ backends: { vault: {}, episodic: {} } }), true);
  // A null/undefined entry must not throw either.
  assert.equal(isHealthy(null), true);
  assert.equal(isHealthy(undefined), true);
});

test('isHealthy: a gate-error entry with both backends ok STAYS healthy (denominator)', () => {
  // no_vault_path is a gate error, not a backend error; it must remain in the
  // healthy denominator so the pass rate is not inflated.
  const gateError = { gate: { error: 'no_vault_path' }, backends: { vault: {}, episodic: {} } };
  assert.equal(isHealthy(gateError), true);
});

test('isGatePassed is strict-true only', () => {
  assert.equal(isGatePassed({ gate: { passed: true } }), true);
  assert.equal(isGatePassed({ gate: { passed: false } }), false);
  // Truthy-but-not-true must NOT count as passed.
  assert.equal(isGatePassed({ gate: { passed: 1 } }), false);
  assert.equal(isGatePassed({ gate: {} }), false);
  // Missing gate / entry must return false, not throw — the ?. is load-bearing.
  assert.equal(isGatePassed({}), false);
  assert.equal(isGatePassed(null), false);
  assert.equal(isGatePassed(undefined), false);
});

test('backend-health thresholds hold their documented values', () => {
  assert.equal(SHADOW_BACKEND_HEALTH_MIN_RATE, 0.6);
  assert.equal(SHADOW_BACKEND_HEALTH_MIN_TOTAL, 50);
});
