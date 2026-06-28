// tests/download-binary-offline.test.mjs : the LL_OFFLINE backstop in main().
//
// download-binary.mjs is the manual fetch path (/init, health quick). When
// LL_OFFLINE is set it must exit 0 without attempting any network call —
// covering direct invocation that bypasses the SessionStart gates.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MOD_PATH = fileURLToPath(new URL('../plugin/scripts/download-binary.mjs', import.meta.url));

test('LL_OFFLINE makes the manual downloader exit 0 without fetching', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'll-dloff-'));
  try {
    const out = spawnSync(process.execPath, [MOD_PATH], {
      encoding: 'utf-8',
      // 5s ceiling: a real fetch attempt would take far longer / hang; a clean
      // offline exit returns immediately.
      timeout: 5000,
      env: { ...process.env, LL_OFFLINE: '1', CLAUDE_PLUGIN_DATA: dataDir },
    });
    assert.equal(out.status, 0, `expected exit 0, got ${out.status}; stderr: ${out.stderr}`);
    assert.match(out.stderr, /LL_OFFLINE/, 'should report it skipped due to LL_OFFLINE');
    // No bin/ directory should have been created — nothing was downloaded.
    const entries = readdirSync(dataDir);
    assert.ok(
      !entries.includes('bin'),
      `offline run must not create a bin dir; saw: ${entries.join(', ')}`,
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
