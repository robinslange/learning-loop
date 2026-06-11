import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HookConfig } from '../scripts/lib/hook-config.mjs';

test('HookConfig is frozen', () => {
  assert.equal(Object.isFrozen(HookConfig), true);
  assert.throws(() => {
    HookConfig.LABEL_TIMEOUT_MS = 99;
  }, TypeError);
});

test('all values are finite non-negative numbers', () => {
  for (const [k, v] of Object.entries(HookConfig)) {
    assert.equal(typeof v, 'number', `${k} should be a number`);
    assert.equal(Number.isFinite(v), true, `${k} should be finite`);
    assert.ok(v >= 0, `${k} should be non-negative`);
  }
});

test('timeout constants are in plausible ranges (ms)', () => {
  assert.ok(HookConfig.LABEL_TIMEOUT_MS >= 100 && HookConfig.LABEL_TIMEOUT_MS <= 30_000);
  assert.ok(HookConfig.SNAPSHOT_TIMEOUT_MS >= 1000 && HookConfig.SNAPSHOT_TIMEOUT_MS <= 30_000);
  assert.ok(HookConfig.DAEMON_STARTUP_DEADLINE_MS >= 100);
  assert.ok(HookConfig.SESSION_SWEEP_TTL_MS > 24 * 3600 * 1000, 'TTL should be > 1 day');
});

test('ML thresholds are in [0, 1]', () => {
  for (const k of ['INJECTION_THRESHOLD', 'SIMILARITY_THRESHOLD', 'COSINE_MIN', 'COSINE_MAX']) {
    assert.ok(HookConfig[k] >= 0 && HookConfig[k] <= 1, `${k} must be in [0, 1]`);
  }
  assert.ok(HookConfig.COSINE_MAX > HookConfig.COSINE_MIN, 'COSINE_MAX must exceed COSINE_MIN');
});

test('required keys are all present (regression guard)', () => {
  const required = [
    'LABEL_TIMEOUT_MS',
    'QUERY_TIMEOUT_MS',
    'INJECTION_RACE_CAP_MS',
    'DEDUPE_WINDOW_MS',
    'SESSION_SWEEP_TTL_MS',
    'EDGES_TMP_ORPHAN_TTL_MS',
    'CONVERGENCE_TTL_MS',
    'INJECTION_THRESHOLD',
    'SIMILARITY_THRESHOLD',
    'HOOK_STDOUT_MAX_BYTES',
    'REFLECT_COOLDOWN_SECS',
    'DREAM_COOLDOWN_SECS',
    'ERROR_MSG_MAX_CHARS',
    'LABEL_MAX_LENGTH',
    'MSG_WEIGHT_CURRENT',
    'MSG_WEIGHT_RECENT',
    'MSG_WEIGHT_OLDER',
    'COSINE_MIN',
    'COSINE_MAX',
  ];
  for (const k of required) {
    assert.ok(k in HookConfig, `missing required key: ${k}`);
  }
});

test('cooldown constants match known source values', () => {
  // hooks/stop-nudge.js:38 = 300, hooks/stop-nudge.js:77 = 300
  assert.equal(HookConfig.REFLECT_COOLDOWN_SECS, 300);
  assert.equal(HookConfig.DREAM_COOLDOWN_SECS, 300);
});

test('SESSION_SWEEP_TTL_MS is exactly 7 days in milliseconds', () => {
  assert.equal(HookConfig.SESSION_SWEEP_TTL_MS, 7 * 24 * 60 * 60 * 1000);
});

test('EDGES_TMP_ORPHAN_TTL_MS is exactly 1 hour in milliseconds', () => {
  assert.equal(HookConfig.EDGES_TMP_ORPHAN_TTL_MS, 60 * 60 * 1000);
});

test('CONVERGENCE_TTL_MS is exactly 7 days in milliseconds', () => {
  assert.equal(HookConfig.CONVERGENCE_TTL_MS, 7 * 24 * 60 * 60 * 1000);
});

test('DEDUPE_WINDOW_MS is exactly 3 minutes in milliseconds', () => {
  assert.equal(HookConfig.DEDUPE_WINDOW_MS, 3 * 60 * 1000);
});

test('pre-write-check inner query budget leaves headroom inside its hooks.json timeout', () => {
  const hooksJson = JSON.parse(
    readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8'),
  );
  const entry = hooksJson.hooks.PreToolUse.find((e) => e.matcher.split('|').includes('Write'));
  assert.ok(entry, 'hooks.json must have a PreToolUse entry whose matcher includes Write');
  assert.ok(entry.hooks?.[0]?.timeout, 'the PreToolUse Write entry must declare a timeout');
  const hookBudgetMs = entry.hooks[0].timeout * 1000;
  assert.ok(
    HookConfig.QUERY_TIMEOUT_MS < hookBudgetMs,
    `QUERY_TIMEOUT_MS (${HookConfig.QUERY_TIMEOUT_MS}ms) must be strictly inside the ` +
      `pre-write-check hook budget (${hookBudgetMs}ms): an inner exec that eats the whole ` +
      `window gets the hook killed, losing every warning`,
  );
});
