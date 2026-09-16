import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HookConfig } from '../plugin/scripts/lib/hook-config.mjs';
import { outerDeadlineMs } from '../plugin/hooks/pre-write-check.js';

const HOOKS_JSON = JSON.parse(
  readFileSync(new URL('../plugin/hooks/hooks.json', import.meta.url), 'utf8'),
);

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
  // 2026-07-16 recalibration: the gate now requires corroboration BEYOND two
  // bare top hits — it sits ABOVE the two-strong-signals floor (2/6) to cut the
  // 0.32-0.40 band the relevance study found least on-topic. The upper bound
  // keeps it below the observed passing p50 (~0.44) so the corroborated core
  // still injects. See the derivation comment in hook-config.mjs.
  assert.ok(
    HookConfig.INJECTION_THRESHOLD > 2 / 6,
    'gate must exceed the two-bare-signals floor (2/(5+1)) after the precision cut',
  );
  assert.ok(
    HookConfig.INJECTION_THRESHOLD < 0.45,
    'gate must stay below the p50 of passing scores so the corroborated core still injects',
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

test('DEDUPE_WINDOW_MS is exactly 4 hours in milliseconds', () => {
  assert.equal(HookConfig.DEDUPE_WINDOW_MS, 4 * 60 * 60 * 1000);
});

// The window must outlast a working session's repeat cadence but stay inside
// the sweep that reaps the state files, or the per-session dedupe entries are
// pruned out from under it.
test('DEDUPE_WINDOW_MS sits below the session artifact sweep TTL', () => {
  assert.ok(
    HookConfig.DEDUPE_WINDOW_MS < HookConfig.SESSION_SWEEP_TTL_MS,
    'dedupe entries must not outlive the sweep that reaps them',
  );
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
// The fix uses elapsed-aware budgeting: the subprocess timeout is whatever
// remains (budget - elapsed - margin), so the composed spend is always at most
// the outer deadline. The static checks here pin the invariants that make that
// arithmetic safe. The budget itself is NOT restated in hook-config -- it is
// read from hooks.json, the only file the harness actually enforces.
test('pre-write-check composed worst case (daemon + subprocess) fits inside its hooks.json timeout', () => {
  const hooksJson = JSON.parse(
    readFileSync(new URL('../plugin/hooks/hooks.json', import.meta.url), 'utf8'),
  );
  const entry = hooksJson.hooks.PreToolUse.find((e) => e.matcher.split('|').includes('Write'));
  assert.ok(entry, 'hooks.json must have a PreToolUse entry whose matcher includes Write');
  assert.ok(entry.hooks?.[0]?.timeout, 'the PreToolUse Write entry must declare a timeout');
  const hookBudgetMs = entry.hooks[0].timeout * 1000;

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

  // The subprocess timer is the remaining wall clock, so the composed worst
  // case is exactly the outer deadline (the runtime arithmetic guarantees it).
  // Verify the daemon timer is strictly shorter than the budget so a wedged
  // daemon doesn't eat the whole window before the fallback.
  assert.ok(
    HookConfig.PRE_WRITE_DAEMON_TIMEOUT_MS < hookBudgetMs,
    `PRE_WRITE_DAEMON_TIMEOUT_MS (${HookConfig.PRE_WRITE_DAEMON_TIMEOUT_MS}ms) must be ` +
      `strictly less than the hook budget (${hookBudgetMs}ms): a daemon timeout that equals ` +
      `the outer budget leaves no time for the subprocess fallback`,
  );
});

// Regression: the budget has to fit a COLD start, not just a warm daemon. On a
// platform with no socket transport there is no warm path at all (nli_server.rs
// is `#![cfg(unix)]`), so every vault-note write pays a full ONNX model load. A
// measured cold `ll-search query` on a Windows host with a 98-note vault took
// 2905ms, against a 3000ms budget less a 300ms margin -- so the subprocess
// fallback could never finish, every call logged ETIMEDOUT, and the gate passed
// silently on 55 consecutive writes (#5) while reporting itself healthy.
//
// The budget is a CEILING, not a delay: a warm daemon still answers in ~430ms,
// and pre-write-check early-exits on any path outside the vault, so ordinary
// code edits never reach the gate and never pay this.
test('the pre-write budget fits a cold model start, not just a warm daemon', () => {
  const COLD_START_OBSERVED_MS = 2905;
  const usable = outerDeadlineMs(HOOKS_JSON) - HookConfig.PRE_WRITE_SAFETY_MARGIN_MS;
  assert.ok(
    usable > COLD_START_OBSERVED_MS,
    `usable subprocess window (${usable}ms = hooks.json deadline less margin ` +
      `${HookConfig.PRE_WRITE_SAFETY_MARGIN_MS}) must exceed the observed ${COLD_START_OBSERVED_MS}ms cold ` +
      `start, or the fallback is killed before it can answer and the gate fails open on every vault write`,
  );
});

// The outer deadline has exactly one declaration, and this is the reader for
// it. hooks.json is the authority because it is the copy the harness enforces:
// Claude Code parses it at session start and SIGKILLs the hook on it. A second
// copy in hook-config could only ever agree or drift, and drift is silent --
// an inner budget above the outer deadline is inert, one below it throws away
// time the hook was given. The mirror test that used to police those two
// literals is gone with the literal it policed.
test('outerDeadlineMs reads the deadline the harness actually enforces', () => {
  assert.equal(
    outerDeadlineMs(HOOKS_JSON),
    HOOKS_JSON.hooks.PreToolUse.find((e) => e.matcher.split('|').includes('Write')).hooks[0]
      .timeout * 1000,
  );
});

test('outerDeadlineMs picks the Write entry, not whichever PreToolUse hook is first', () => {
  // hooks.json declares more than one PreToolUse group (web-guard is the
  // other). Taking [0] would silently budget the duplicate gate against a
  // different hook's deadline.
  const deadline = outerDeadlineMs({
    hooks: {
      PreToolUse: [
        { matcher: 'WebSearch|WebFetch', hooks: [{ timeout: 3 }] },
        { matcher: 'Write|Edit', hooks: [{ timeout: 8 }] },
      ],
    },
  });
  assert.equal(deadline, 8000);
});

test('outerDeadlineMs returns null when the deadline cannot be read', () => {
  // The caller floors low on null rather than guessing: under-running the real
  // deadline only wastes time the hook was given, while over-running it is the
  // SIGKILL that loses every warning already computed.
  for (const bad of [null, undefined, {}, { hooks: {} }, { hooks: { PreToolUse: [] } }]) {
    assert.equal(outerDeadlineMs(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
  assert.equal(
    outerDeadlineMs({ hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{}] }] } }),
    null,
    'an entry with no timeout is unreadable, not zero',
  );
});

// Regression: any hook that reads stdin via the shared readStdin() (which
// races HookConfig.STDIN_TIMEOUT_MS) must declare a hooks.json timeout long
// enough that the stdin wait alone can't exhaust the outer deadline. Pre-fix,
// post-read-retrieval.js and post-search-tracking.js declared 2s while
// STDIN_TIMEOUT_MS was 3000 — a slow/absent stdin write could let Claude Code
// SIGKILL the hook before readStdin's own timeout ever fires. Scanned across
// ALL event groups (not just PostToolUse) so a new stdin hook like
// subagent-stop.js is covered automatically.
test('stdin-reading hooks declare a hooks.json timeout longer than STDIN_TIMEOUT_MS', () => {
  const hooksJson = JSON.parse(
    readFileSync(new URL('../plugin/hooks/hooks.json', import.meta.url), 'utf8'),
  );
  const stdinReadingHooks = [
    'post-read-retrieval.js',
    'post-search-tracking.js',
    'subagent-stop.js',
    'session-label.js',
  ];

  let checked = 0;
  for (const groups of Object.values(hooksJson.hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        const match = stdinReadingHooks.find((name) => hook.command.includes(name));
        if (!match) continue;
        checked += 1;
        const hookBudgetMs = hook.timeout * 1000;
        assert.ok(
          HookConfig.STDIN_TIMEOUT_MS < hookBudgetMs,
          `${match}'s hooks.json timeout (${hookBudgetMs}ms) must exceed ` +
            `STDIN_TIMEOUT_MS (${HookConfig.STDIN_TIMEOUT_MS}ms): otherwise the outer deadline ` +
            `can SIGKILL the hook before its own stdin read gives up`,
        );
      }
    }
  }
  assert.equal(checked, stdinReadingHooks.length, 'every named stdin hook must be present in hooks.json');
});
