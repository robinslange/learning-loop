// Regression test for Phase 2: refinement-candidates.mjs must not silently
// fall back to ~/brain/brain when VAULT_PATH is unconfigured. The script
// should exit non-zero with a clear stderr message instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SCRIPT = resolve(REPO_ROOT, 'scripts/refinement-candidates.mjs');

test('refinement-candidates: exits non-zero with diagnostic when vault path unconfigured', () => {
  const sb = mkdtempSync(join(tmpdir(), 'll-vp-test-'));
  const pdDir = join(sb, 'plugin-data');
  mkdirSync(pdDir, { recursive: true });
  // Defeat BOTH fallback paths inside lib/config.mjs:getConfig() —
  // primary path (plugin-data/config.json) AND legacy path
  // (<plugin-root>/config.json). Writing an empty config.json at the
  // primary location satisfies the primary branch and prevents the
  // legacy-load shadow that would otherwise pick up the dev repo's
  // own config.json with its vault_path: ~/brain/brain.
  writeFileSync(join(pdDir, 'config.json'), '{}');
  try {
    // Pass a single bogus note path so the script reaches vault-path
    // resolution; without it, the script would short-circuit on missing args.
    const r = spawnSync(process.execPath, [SCRIPT, 'fake-note.md'], {
      env: {
        PATH: process.env.PATH,
        HOME: sb,
        CLAUDE_PLUGIN_DATA: pdDir,
      },
      encoding: 'utf8',
      timeout: 5000,
    });

    assert.notEqual(
      r.status,
      0,
      `expected non-zero exit when VAULT_PATH unset; got status=${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );
    assert.ok(
      /VAULT_PATH|vault_path/i.test(r.stderr),
      `stderr should name the missing config key; got: ${r.stderr}`,
    );
    assert.ok(
      !r.stdout.includes('/brain/brain/'),
      `must not silently operate on ~/brain/brain; stdout: ${r.stdout}`,
    );
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
});

test('refinement-candidates: treats VAULT_PATH="" as unset', () => {
  // Lock in the empty-string behavior. getVaultPath uses `process.env.X || cfg.x`,
  // so empty string short-circuits to the config lookup. If someone "fixes" the
  // `||` to `??` later, this test catches the regression.
  const sb = mkdtempSync(join(tmpdir(), 'll-vp-empty-'));
  const pdDir = join(sb, 'plugin-data');
  mkdirSync(pdDir, { recursive: true });
  writeFileSync(join(pdDir, 'config.json'), '{}');
  try {
    const r = spawnSync(process.execPath, [SCRIPT, 'fake-note.md'], {
      env: {
        PATH: process.env.PATH,
        HOME: sb,
        CLAUDE_PLUGIN_DATA: pdDir,
        VAULT_PATH: '',
      },
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.notEqual(
      r.status,
      0,
      `expected non-zero exit when VAULT_PATH=""; got status=${r.status}\nstderr: ${r.stderr}`,
    );
    assert.ok(
      /VAULT_PATH|vault_path/i.test(r.stderr),
      `stderr should name the missing config key; got: ${r.stderr}`,
    );
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
});

test('refinement-candidates: expands ~ in VAULT_PATH (vs treating it literally)', () => {
  // Behavior change from Phase 2: hooks-side resolveVaultPath used to call
  // resolve(process.env.VAULT_PATH) without ~ expansion. After the collapse
  // to canonical getVaultPath (which uses expandHome), VAULT_PATH=~/x now
  // resolves to <home>/x instead of <cwd>/~/x. We don't assert the
  // resolved path directly (the script never echoes it) — instead we assert
  // the script does NOT emit a "not configured" error, proving that `~/x`
  // was accepted as a valid VAULT_PATH.
  const sb = mkdtempSync(join(tmpdir(), 'll-vp-tilde-'));
  mkdirSync(join(sb, 'my-vault'), { recursive: true });
  try {
    const r = spawnSync(process.execPath, [SCRIPT, 'fake-note.md'], {
      env: {
        PATH: process.env.PATH,
        HOME: sb,
        VAULT_PATH: '~/my-vault',
      },
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.ok(
      !/VAULT_PATH .*not configured/i.test(r.stderr),
      `~ expansion should succeed (VAULT_PATH=~/my-vault → <home>/my-vault); stderr: ${r.stderr}`,
    );
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
});

test('refinement-candidates: respects VAULT_PATH env when set', () => {
  // Sanity check the positive path: with VAULT_PATH explicitly set the
  // script should at least progress past vault-path resolution and not
  // emit the unconfigured diagnostic. We don't assert success — the
  // script may still fail for other reasons (no index, no candidates),
  // but it must not complain about VAULT_PATH being unset.
  const sb = mkdtempSync(join(tmpdir(), 'll-vp-set-'));
  const vault = join(sb, 'my-vault');
  mkdirSync(vault, { recursive: true });
  try {
    const r = spawnSync(process.execPath, [SCRIPT, 'fake-note.md'], {
      env: {
        PATH: process.env.PATH,
        HOME: sb,
        VAULT_PATH: vault,
      },
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.ok(
      !/VAULT_PATH .*not configured/i.test(r.stderr),
      `should not complain about VAULT_PATH when set; stderr: ${r.stderr}`,
    );
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
});
