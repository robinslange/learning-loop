// tests/provenance-no-resurrect.test.mjs
// Pins "never resurrect a deleted plugin-data": session-start spawns the
// provenance emitter DETACHED; under suite load it can finish after the test
// harness rmSync'd its sandbox, and an unguarded emitter re-creates the
// sandbox via mkdirSync (the residual ll-hook-sb-* leak of 2026-06).

import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const EMITTER = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'provenance.mjs',
);

function emit(pluginData) {
  return spawnSync('node', [EMITTER, JSON.stringify({ agent: 'test', action: 'no-resurrect' })], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData },
    encoding: 'utf-8',
  });
}

test('emitProvenance does not re-create a deleted plugin-data dir', () => {
  const root = mkdtempSync(join(tmpdir(), 'll-prov-gone-'));
  rmSync(root, { recursive: true, force: true });
  const result = emit(root);
  assert.equal(result.status, 0, `emitter must no-op cleanly, stderr: ${result.stderr}`);
  assert.ok(!existsSync(root), 'deleted plugin-data must not be resurrected');
});

test('emitProvenance still appends when plugin-data exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'll-prov-live-'));
  try {
    const result = emit(root);
    assert.equal(result.status, 0, `emitter must succeed, stderr: ${result.stderr}`);
    const month = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
    const eventsFile = join(root, 'provenance', `events-${month}.jsonl`);
    assert.ok(existsSync(eventsFile), 'events file must be written');
    assert.match(readFileSync(eventsFile, 'utf-8'), /"action":"no-resurrect"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
