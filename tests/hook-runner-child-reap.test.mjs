// tests/hook-runner-child-reap.test.mjs
// Pins the detached-child reap seam: session-start's detached children
// (dream-gate refresh, intentions worker, provenance emitter) can write into
// the sandbox while cleanup's rmSync walks it (ENOTEMPTY flake). The harness
// records their pids via LL_CHILD_PID_FILE and reaps them before rm.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runHook } from './helpers/hook-runner.mjs';

const HOOK = new URL('../hooks/session-start.js', import.meta.url).pathname;
const VAULT = new URL('./fixtures/vault-small', import.meta.url).pathname;

// Fresh update-check.json so the hook does not spawn the background
// update-check child that would hit api.github.com.
function seedUpdateCheck(pluginDataDir) {
  writeFileSync(
    join(pluginDataDir, 'update-check.json'),
    JSON.stringify({
      checked: Math.floor(Date.now() / 1000) - 5,
      update_available: false,
      installed: '1.17.3',
      latest: '1.17.3',
    }),
  );
}

test(
  'session-start records detached child pids and cleanup reaps them',
  { timeout: 12000 },
  () => {
    // With a vault + CLAUDE_PLUGIN_DATA present, context-assembly spawns the
    // intentions worker, the dream-gate refresh, and the provenance emitter
    // unconditionally — at least one recorded pid is guaranteed.
    const r = runHook(HOOK, {
      stdin: { session_id: 'child-reap-001' },
      env: { VAULT_PATH: VAULT },
      seed: (pd) => seedUpdateCheck(pd),
    });
    const pidFile = join(r.sandboxRoot, '.child-pids');
    try {
      assert.equal(r.exitCode, 0, r.stderr);
      assert.ok(existsSync(pidFile), 'detached children must be recorded');
      const pids = readFileSync(pidFile, 'utf8').split('\n').filter(Boolean).map(Number);
      assert.ok(pids.length >= 1, 'at least one detached child recorded');
      r.cleanup();
      for (const pid of pids) {
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
        }
        assert.ok(!alive, `child ${pid} must be dead after cleanup`);
      }
    } finally {
      // cleanup() may already have run; calling twice is safe (rmSync force).
      r.cleanup();
    }
  },
);
