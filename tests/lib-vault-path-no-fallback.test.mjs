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
