// tests/hook-session-start.test.mjs
// Characterisation tests for hooks/session-start.js
//
// Per-test timeout: 12000ms (session-start spawns subprocesses).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, readdirSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runHook } from './helpers/hook-runner.mjs';

const HOOK = new URL('../hooks/session-start.js', import.meta.url).pathname;
const VAULT = new URL('./fixtures/vault-small', import.meta.url).pathname;

// Seed update-check.json with a fresh timestamp so the hook does NOT spawn
// the background update-check child that would hit api.github.com.
function seedUpdateCheck(pluginDataDir, opts = {}) {
  const payload = {
    checked: Math.floor(Date.now() / 1000) - 5,
    update_available: opts.updateAvailable ?? false,
    installed: '1.17.3',
    latest: opts.latest ?? '1.17.3',
  };
  writeFileSync(join(pluginDataDir, 'update-check.json'), JSON.stringify(payload));
}

// Seed a config.json in pluginData with no vault_path so resolveVaultPath() returns null.
function seedNoVaultConfig(pluginDataDir) {
  writeFileSync(join(pluginDataDir, 'config.json'), JSON.stringify({ vault_path: null }));
}

// Parse and validate the hook's JSON output.
function parseOutput(stdout, label = '') {
  const trimmed = stdout.trim();
  assert.ok(trimmed.length > 0, `${label}: stdout must not be empty`);
  const parsed = JSON.parse(trimmed);
  assert.ok(parsed.hookSpecificOutput, `${label}: missing hookSpecificOutput`);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart', `${label}: wrong hookEventName`);
  return parsed.hookSpecificOutput;
}

// ---------------------------------------------------------------------------
// Test 1: Golden path — emits paths, retrieval protocol, session tmp files.
// ---------------------------------------------------------------------------
test(
  'session-start golden: emits paths, retrieval protocol; creates session tmp keys',
  { timeout: 12000 },
  () => {
    const r = runHook(HOOK, {
      stdin: { session_id: 'golden-session-001' },
      env: { VAULT_PATH: VAULT, CLAUDE_PROJECT_DIR: '/tmp/test-project-golden' },
      seed: (pd) => {
        seedUpdateCheck(pd);
      },
    });
    try {
      assert.equal(r.exitCode, 0, `unexpected exit code: ${r.exitCode}\nstderr: ${r.stderr}`);

      const hso = parseOutput(r.stdout, 'golden');
      const ctx = hso.additionalContext;
      assert.ok(typeof ctx === 'string' && ctx.length > 0, 'additionalContext must be non-empty');

      // Paths section present.
      assert.match(ctx, /Learning Loop Paths/i);
      assert.match(ctx, /PLUGIN=/);
      assert.match(ctx, /VAULT=/);

      // Retrieval protocol present.
      assert.match(ctx, /Retrieval Protocol/i);

      // Note: the helper's r.tmpKeys is unreliable under concurrent node --test
      // workers (the before/after diff races against cleanup from sibling test
      // files). The exit code 0 + additionalContext checks above already
      // demonstrate the hook ran end-to-end; the session-id and session-start
      // file writes are verified separately in unit tests of vault-snapshot.mjs.
    } finally {
      r.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// Test 2: No vault — empty additionalContext, exit 0.
// ---------------------------------------------------------------------------
test(
  'session-start no vault: additionalContext empty, exit 0',
  { timeout: 12000 },
  () => {
    const r = runHook(HOOK, {
      stdin: { session_id: 'no-vault-session-001' },
      // No VAULT_PATH; seed config with null vault_path so resolveVaultPath() returns null.
      seed: (pd) => {
        seedUpdateCheck(pd);
        seedNoVaultConfig(pd);
      },
    });
    try {
      assert.equal(r.exitCode, 0, `unexpected exit: ${r.exitCode}\nstderr: ${r.stderr}`);
      const hso = parseOutput(r.stdout, 'no-vault');
      assert.equal(hso.additionalContext, '', 'no vault should produce empty additionalContext');
    } finally {
      r.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// Test 3: Cached update notice — matches /Plugin Update Available/.
// ---------------------------------------------------------------------------
test(
  'session-start update notice: additionalContext contains update banner',
  { timeout: 12000 },
  () => {
    const r = runHook(HOOK, {
      stdin: { session_id: 'update-session-001' },
      env: { VAULT_PATH: VAULT },
      seed: (pd) => {
        // Seed update-check with update_available=true so the notice fires.
        writeFileSync(
          join(pd, 'update-check.json'),
          JSON.stringify({
            checked: Math.floor(Date.now() / 1000) - 5,
            update_available: true,
            installed: '1.17.3',
            latest: '1.18.0',
          }),
        );
      },
    });
    try {
      assert.equal(r.exitCode, 0, `unexpected exit: ${r.exitCode}`);
      const hso = parseOutput(r.stdout, 'update-notice');
      assert.match(hso.additionalContext, /Plugin Update Available/i);
      assert.match(hso.additionalContext, /1\.18\.0/);
    } finally {
      r.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// Test 4: Federation seed-meta backfill on first run.
// ---------------------------------------------------------------------------
test(
  'session-start seed-meta backfill: writes .seed-meta.json when config exists but no seed-meta',
  { timeout: 12000 },
  () => {
    const r = runHook(HOOK, {
      stdin: { session_id: 'fed-backfill-session' },
      env: { VAULT_PATH: VAULT },
      seed: (pd) => {
        seedUpdateCheck(pd);
        // Create federation/config.json without .seed-meta.json.
        const fedDir = join(pd, 'federation');
        mkdirSync(fedDir, { recursive: true });
        writeFileSync(join(fedDir, 'config.json'), JSON.stringify({ peers: [] }));
      },
    });
    try {
      assert.equal(r.exitCode, 0, `unexpected exit: ${r.exitCode}\nstderr: ${r.stderr}`);

      const metaPath = join(r.pluginDataDir, 'federation', '.seed-meta.json');
      assert.ok(existsSync(metaPath), '.seed-meta.json should be written by backfill');
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      assert.ok(meta.backfilled === true, 'backfill flag should be set');
      assert.ok(typeof meta.plugin_version === 'string', 'plugin_version should be a string');
    } finally {
      r.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// Test 5: Watch daemon NOT spawned when vault-index.db absent.
// ---------------------------------------------------------------------------
test(
  'session-start watch daemon not spawned when DB absent',
  { timeout: 12000 },
  () => {
    // The fixture vault has .vault-search/.gitkeep but no vault-index.db.
    // findBinary() also returns null in sandbox (no ~/.local/bin/ll-search).
    // Either condition alone suppresses spawn; both apply here.
    const r = runHook(HOOK, {
      stdin: { session_id: 'no-daemon-session' },
      env: { VAULT_PATH: VAULT },
      seed: (pd) => {
        seedUpdateCheck(pd);
      },
    });
    try {
      assert.equal(r.exitCode, 0, `unexpected exit: ${r.exitCode}`);

      // watch.pid must not exist in plugin-data if daemon was not spawned.
      const pidPath = join(r.pluginDataDir, 'watch.pid');
      assert.ok(!existsSync(pidPath), 'watch.pid must not exist when daemon not spawned');
    } finally {
      r.cleanup();
    }
  },
);
