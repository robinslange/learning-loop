import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HookConfig } from '../plugin/scripts/lib/hook-config.mjs';

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
  assert.ok(
    HookConfig.SESSION_SWEEP_TTL_MS > 24 * 3600 * 1000 &&
      HookConfig.SESSION_SWEEP_TTL_MS <= 30 * 24 * 3600 * 1000,
    'TTL should be > 1 day and <= 30 days',
  );
});

test('ML thresholds are in [0, 1]', () => {
  for (const k of ['INJECTION_THRESHOLD', 'SIMILARITY_THRESHOLD', 'COSINE_MIN', 'COSINE_MAX']) {
    assert.ok(HookConfig[k] >= 0 && HookConfig[k] <= 1, `${k} must be in [0, 1]`);
  }
  assert.ok(HookConfig.COSINE_MAX > HookConfig.COSINE_MIN, 'COSINE_MAX must exceed COSINE_MIN');
});

test('INJECTION_THRESHOLD is calibrated to the RRF fusion-sum scale', () => {
  // ll-search fuses five signals with RRF_K=5: each contributes 1/(5+rank).
  // A lone #1 in one signal scores 1/6 ≈ 0.167; #1 in two signals 2/6 ≈ 0.333.
  // The gate must admit a two-strong-signals match (the observed nonzero
  // floor in the shadow logs) and reject a lone single-signal #1 — see the
  // derivation comment in hook-config.mjs.
  assert.ok(
    HookConfig.INJECTION_THRESHOLD <= 2 / 6,
    'gate must not exceed the two-strong-signals floor (2/(5+1))',
  );
  assert.ok(
    HookConfig.INJECTION_THRESHOLD > 1 / 6,
    'gate must exceed a lone single-signal #1 (1/(5+1))',
  );
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

test('EDGES_TMP_ORPHAN_TTL_MS is exactly 1 hour in milliseconds', () => {
  assert.equal(HookConfig.EDGES_TMP_ORPHAN_TTL_MS, 60 * 60 * 1000);
});

test('CONVERGENCE_TTL_MS is exactly 7 days in milliseconds', () => {
  assert.equal(HookConfig.CONVERGENCE_TTL_MS, 7 * 24 * 60 * 60 * 1000);
});

test('DEDUPE_WINDOW_MS is exactly 3 minutes in milliseconds', () => {
  assert.equal(HookConfig.DEDUPE_WINDOW_MS, 3 * 60 * 1000);
});

// Regression: post-tool's worst-case inner spend (stdin ceiling + one full
// module budget per module) must fit inside its hooks.json deadline. Pre-fix
// the outer timeout was 7s against an 11s inner worst case, so Claude Code
// could SIGKILL the hook mid-module-loop and silently drop the tail modules.
test('post-tool inner budgets compose inside its hooks.json timeout', () => {
  const hooksJson = JSON.parse(
    readFileSync(new URL('../plugin/hooks/hooks.json', import.meta.url), 'utf8'),
  );
  const entry = hooksJson.hooks.PostToolUse.find((e) => e.matcher.split('|').includes('Write'));
  assert.ok(entry?.hooks?.[0]?.timeout, 'hooks.json must declare a post-tool timeout');
  const hookBudgetMs = entry.hooks[0].timeout * 1000;

  // Count the Write/Edit module chain from the post-tool source so this test
  // tracks module additions instead of hard-coding 4.
  const src = readFileSync(new URL('../plugin/hooks/post-tool.js', import.meta.url), 'utf8');
  const m = src.match(/const modules = isWriteEdit\s*\?\s*\[([^\]]+)\]/);
  assert.ok(m, 'post-tool.js must declare the isWriteEdit module array');
  const moduleCount = m[1].split(',').filter((s) => s.trim()).length;
  assert.ok(moduleCount >= 4, `expected >= 4 write/edit modules, found ${moduleCount}`);

  const worstCaseMs =
    HookConfig.STDIN_TIMEOUT_MS + moduleCount * HookConfig.POST_TOOL_MODULE_TIMEOUT_MS;
  assert.ok(
    worstCaseMs < hookBudgetMs,
    `post-tool worst-case inner spend (${worstCaseMs}ms = stdin ${HookConfig.STDIN_TIMEOUT_MS} + ` +
      `${moduleCount} x ${HookConfig.POST_TOOL_MODULE_TIMEOUT_MS}) must be strictly inside the ` +
      `hooks.json budget (${hookBudgetMs}ms): an outer SIGKILL mid-loop silently drops the ` +
      `remaining modules with no hook-errors record`,
  );
});

test('pre-write-check inner query budget leaves headroom inside its hooks.json timeout', () => {
  const hooksJson = JSON.parse(
    readFileSync(new URL('../plugin/hooks/hooks.json', import.meta.url), 'utf8'),
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
