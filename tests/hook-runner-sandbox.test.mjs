// tests/hook-runner-sandbox.test.mjs
// Pins the sandbox-hygiene contract of the hook-runner helper. Regression
// guard for the 2026-06 leak: sandboxes with no bin/.version looked like
// fresh installs, so session-start's cache-cleanup spawned a DETACHED
// download-binary.mjs into every sandbox; the detached child outlived
// cleanup() and re-created the sandbox with a 290MB binary ($TMPDIR filled,
// Gatekeeper rescans caused the spawn-timeout flakes).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  utimesSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { runHook, sweepStaleSandboxes } from './helpers/hook-runner.mjs';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(new URL('../plugin/hooks/pre-write-check.js', import.meta.url));
const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// A non-Write tool makes pre-write-check exit immediately — cheapest real hook.
const NOOP_STDIN = { tool_name: 'Read', tool_input: {} };

test('runHook seeds bin/.version matching the running plugin version (downloader suppressed)', () => {
  const r = runHook(HOOK, { stdin: NOOP_STDIN });
  try {
    const v = readFileSync(join(r.pluginDataDir, 'bin', '.version'), 'utf8').trim();
    assert.equal(v, `v${PKG.version}`);
  } finally {
    r.cleanup();
  }
});

test('a seed-provided bin/ll-search stub is never replaced by the symlink step', () => {
  const r = runHook(HOOK, {
    stdin: NOOP_STDIN,
    seed: (pd) => {
      mkdirSync(join(pd, 'bin'), { recursive: true });
      // Plain file, not executable — we only check identity, not execution.
      writeFileSync(join(pd, 'bin', 'll-search'), 'stub-marker');
    },
  });
  try {
    assert.equal(readFileSync(join(r.pluginDataDir, 'bin', 'll-search'), 'utf8'), 'stub-marker');
  } finally {
    r.cleanup();
  }
});

test('cleanup removes the sandbox root', () => {
  const r = runHook(HOOK, { stdin: NOOP_STDIN });
  assert.ok(existsSync(r.sandboxRoot));
  r.cleanup();
  assert.ok(!existsSync(r.sandboxRoot));
});

test('sweepStaleSandboxes removes ll-hook-sb-* older than 1h, keeps fresh ones', () => {
  // mkdtemp-unique names: fixed fixture names would race with a parallel
  // session running this same suite.
  const oldDir = mkdtempSync(join(tmpdir(), 'll-hook-sb-stale-'));
  const freshDir = mkdtempSync(join(tmpdir(), 'll-hook-sb-fresh-'));
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(oldDir, twoHoursAgo, twoHoursAgo);
  try {
    sweepStaleSandboxes();
    assert.ok(!existsSync(oldDir), 'stale sandbox must be swept');
    assert.ok(existsSync(freshDir), 'fresh sandbox must survive');
  } finally {
    rmSync(oldDir, { recursive: true, force: true });
    rmSync(freshDir, { recursive: true, force: true });
  }
});

// The installed plugin's binary is whatever version last shipped, not what
// this branch builds, and it lives outside the sandbox. runHook must never
// link it in, even when the test runner's own env points at an install.
test('runHook never links the installed plugin binary into a sandbox', () => {
  const installed = mkdtempSync(join(tmpdir(), 'll-installed-pd-'));
  try {
    mkdirSync(join(installed, 'bin'), { recursive: true });
    writeFileSync(join(installed, 'bin', 'll-search'), 'installed-decoy', { mode: 0o755 });
    const runner = new URL('./helpers/hook-runner.mjs', import.meta.url).href;
    const r = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { runHook } = await import(${JSON.stringify(runner)});
         const { readFileSync, realpathSync } = await import('node:fs');
         const r = runHook(${JSON.stringify(HOOK)}, { stdin: ${JSON.stringify(NOOP_STDIN)} });
         const bin = r.pluginDataDir + '/bin/ll-search';
         let seen = null;
         try { seen = { real: realpathSync(bin), head: readFileSync(bin, 'latin1').slice(0, 15) }; } catch {}
         r.cleanup();
         console.log(JSON.stringify(seen));`,
      ],
      { encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_DATA: installed } },
    );
    assert.equal(r.status, 0, r.stderr);
    const seen = JSON.parse(r.stdout.trim().split('\n').at(-1));
    assert.ok(
      !seen?.real.startsWith(realpathSync(installed)),
      `sandbox links the install: ${seen?.real}`,
    );
    assert.notEqual(seen?.head, 'installed-decoy', 'sandbox holds a copy of the installed binary');
  } finally {
    rmSync(installed, { recursive: true, force: true });
  }
});
