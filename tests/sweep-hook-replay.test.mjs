// Regression test for scripts/sweep-hook-replay.mjs.
// The script broke silently from v1.16.10 to v1.16.13 because it shelled out
// to hooks that had been merged into hooks/post-tool.js. These tests cover
// the argument/IO surface that does NOT require a working post-tool.js end
// state (vault, snapshot, daemon, binary): help text, missing-file path,
// stdin path-list parsing, and the JSON summary shape.

import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', 'scripts', 'sweep-hook-replay.mjs');

function run(args, opts = {}) {
  return spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf-8',
    timeout: 20000,
    ...opts,
  });
}

test('--help exits 0 and mentions the post-tool dispatcher', () => {
  const result = run(['--help']);
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /post-tool dispatcher|hooks\/post-tool\.js/);
  assert.match(result.stdout, /--stdin/);
});

test('no args exits 2 with usage on stderr', () => {
  const result = run([]);
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /sweep-hook-replay/);
});

test('missing file produces a structured failure entry, not a crash', () => {
  const result = run(['/this/path/cannot/exist/note.md']);
  // Exit 1 because at least one file failed.
  assert.strictEqual(result.status, 1);
  const summary = JSON.parse(result.stdout);
  assert.strictEqual(summary.processed, 1);
  assert.strictEqual(summary.ok, 0);
  assert.strictEqual(summary.failed, 1);
  assert.strictEqual(summary.failures.length, 1);
  assert.match(summary.failures[0].reason, /file not found/i);
});

test('--stdin parses newline-separated paths and reports per-path results', () => {
  // All paths missing: confirms stdin is read, paths are split correctly,
  // and each one yields a failure entry. Does not exercise the dispatcher.
  const stdin = '/nope/a.md\n/nope/b.md\n\n/nope/c.md\n';
  const result = run(['--stdin'], { input: stdin });
  assert.strictEqual(result.status, 1);
  const summary = JSON.parse(result.stdout);
  assert.strictEqual(summary.processed, 3);
  assert.strictEqual(summary.failed, 3);
});

test('summary truncates failures list to 20 entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-sweep-'));
  try {
    // 25 missing-file entries; failures list should cap at 20 even though
    // failed count reflects the true total.
    const paths = Array.from({ length: 25 }, (_, i) => `/nope/note-${i}.md`).join('\n');
    const result = run(['--stdin'], { input: paths });
    const summary = JSON.parse(result.stdout);
    assert.strictEqual(summary.processed, 25);
    assert.strictEqual(summary.failed, 25);
    assert.strictEqual(summary.failures.length, 20);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('script no longer references the legacy per-hook filenames', () => {
  // This is the regression check: the v1.16.10-through-v1.16.12 breakage was
  // that this file shelled out to post-write-autolink.js / post-write-edge-infer.js
  // after the dispatcher consolidation deleted those files. Guard against
  // re-introducing them.
  const src = readFileSync(SCRIPT, 'utf-8');
  assert.ok(!src.includes('post-write-autolink.js'), 'legacy hook reference re-introduced');
  assert.ok(!src.includes('post-write-edge-infer.js'), 'legacy hook reference re-introduced');
  assert.ok(src.includes('post-tool.js'), 'dispatcher invocation must be present');
});
