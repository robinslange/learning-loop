import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HookConfig } from '../plugin/scripts/lib/hook-config.mjs';

test('HookConfig is frozen', () => {
  assert.equal(Object.isFrozen(HookConfig), true);
  assert.throws(() => {
    HookConfig.STDIN_TIMEOUT_MS = 99;
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
  assert.ok(HookConfig.STDIN_TIMEOUT_MS >= 100 && HookConfig.STDIN_TIMEOUT_MS <= 30_000);
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
    'STDIN_TIMEOUT_MS',
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

// Regression: pre-write-check's worst-case inner spend (daemon attempt +
// subprocess fallback + safety margin) must fit inside its hooks.json deadline.
// Pre-fix the daemon used QUERY_TIMEOUT_MS (2s) and the subprocess used another
// full QUERY_TIMEOUT_MS (2s), summing to ~4s+ against a 3s outer deadline —
// Claude Code SIGKILLed the hook mid-subprocess and silently lost all warnings.
//
// The fix uses elapsed-aware budgeting: the subprocess timeout is computed as
// min(QUERY_TIMEOUT_MS, budget - elapsed - margin), so the composed spend is
// always at most PRE_WRITE_HOOK_BUDGET_MS. The static checks here pin the
// invariants that make that arithmetic safe.
test('pre-write-check composed worst case (daemon + subprocess) fits inside its hooks.json timeout', () => {
  const hooksJson = JSON.parse(
    readFileSync(new URL('../plugin/hooks/hooks.json', import.meta.url), 'utf8'),
  );
  const entry = hooksJson.hooks.PreToolUse.find((e) => e.matcher.split('|').includes('Write'));
  assert.ok(entry, 'hooks.json must have a PreToolUse entry whose matcher includes Write');
  assert.ok(entry.hooks?.[0]?.timeout, 'the PreToolUse Write entry must declare a timeout');
  const hookBudgetMs = entry.hooks[0].timeout * 1000;

  // PRE_WRITE_HOOK_BUDGET_MS must mirror the hooks.json timeout — the runtime
  // budget computation uses this constant, so a divergence silently breaks
  // the guard.
  assert.equal(
    HookConfig.PRE_WRITE_HOOK_BUDGET_MS,
    hookBudgetMs,
    `PRE_WRITE_HOOK_BUDGET_MS (${HookConfig.PRE_WRITE_HOOK_BUDGET_MS}ms) must mirror the ` +
      `hooks.json timeout (${hookBudgetMs}ms) — the runtime budget computation uses this constant`,
  );

  // The daemon timer must leave headroom for at least the subprocess floor +
  // safety margin inside the outer budget. If this fails the code always skips
  // the subprocess even after a fast daemon attempt, making the slow path
  // permanently inactive.
  const daemonHeadroom =
    hookBudgetMs - HookConfig.PRE_WRITE_DAEMON_TIMEOUT_MS - HookConfig.PRE_WRITE_SAFETY_MARGIN_MS;
  assert.ok(
    daemonHeadroom >= HookConfig.PRE_WRITE_SUBPROCESS_FLOOR_MS,
    `after daemon (${HookConfig.PRE_WRITE_DAEMON_TIMEOUT_MS}ms) + margin ` +
      `(${HookConfig.PRE_WRITE_SAFETY_MARGIN_MS}ms), remaining (${daemonHeadroom}ms) must be ` +
      `>= subprocess floor (${HookConfig.PRE_WRITE_SUBPROCESS_FLOOR_MS}ms): otherwise the ` +
      `slow-path fallback is permanently skipped`,
  );

  // The subprocess timer is min(QUERY_TIMEOUT_MS, remaining), so the composed
  // worst case is exactly PRE_WRITE_HOOK_BUDGET_MS (the runtime arithmetic
  // guarantees this). Verify the daemon timer is strictly shorter than the
  // budget so a wedged daemon doesn't eat the whole window before the fallback.
  assert.ok(
    HookConfig.PRE_WRITE_DAEMON_TIMEOUT_MS < hookBudgetMs,
    `PRE_WRITE_DAEMON_TIMEOUT_MS (${HookConfig.PRE_WRITE_DAEMON_TIMEOUT_MS}ms) must be ` +
      `strictly less than the hook budget (${hookBudgetMs}ms): a daemon timeout that equals ` +
      `the outer budget leaves no time for the subprocess fallback`,
  );
});

// Regression: any PostToolUse hook that reads stdin via the shared readStdin()
// (which races HookConfig.STDIN_TIMEOUT_MS) must declare a hooks.json timeout
// long enough that the stdin wait alone can't exhaust the outer deadline.
// Pre-fix, post-read-retrieval.js and post-search-tracking.js declared 2s
// while STDIN_TIMEOUT_MS was 3000 — a slow/absent stdin write could let
// Claude Code SIGKILL the hook before readStdin's own timeout ever fires.
test('stdin-reading hooks declare a hooks.json timeout longer than STDIN_TIMEOUT_MS', () => {
  const hooksJson = JSON.parse(
    readFileSync(new URL('../plugin/hooks/hooks.json', import.meta.url), 'utf8'),
  );
  const stdinReadingHooks = ['post-read-retrieval.js', 'post-search-tracking.js'];

  for (const group of hooksJson.hooks.PostToolUse) {
    for (const hook of group.hooks) {
      const match = stdinReadingHooks.find((name) => hook.command.includes(name));
      if (!match) continue;
      const hookBudgetMs = hook.timeout * 1000;
      assert.ok(
        HookConfig.STDIN_TIMEOUT_MS < hookBudgetMs,
        `${match}'s hooks.json timeout (${hookBudgetMs}ms) must exceed ` +
          `STDIN_TIMEOUT_MS (${HookConfig.STDIN_TIMEOUT_MS}ms): otherwise the outer deadline ` +
          `can SIGKILL the hook before its own stdin read gives up`,
      );
    }
  }
});
