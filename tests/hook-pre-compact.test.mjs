// tests/hook-pre-compact.test.mjs
// Characterisation tests for hooks/pre-compact.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runHook } from './helpers/hook-runner.mjs';

const HOOK = new URL('../hooks/pre-compact.js', import.meta.url).pathname;

// -- helpers --

function parseOutput(stdout) {
  assert.ok(stdout.trim().length > 0, 'stdout must not be empty');
  return JSON.parse(stdout.trim());
}

// -- tests --

test('pre-compact golden: returns empty JSON, no hookSpecificOutput', () => {
  // PreCompact does not accept hookSpecificOutput in the universal schema, so
  // the hook must emit a valid no-op payload. Capture work happens in a
  // detached worker (gated by LEARNING_LOOP_PRECOMPACT_SPIKE) and never
  // surfaces in the hook's stdout.
  const r = runHook(HOOK, { stdin: '' });
  try {
    assert.equal(r.exitCode, 0, `unexpected exit code: ${r.exitCode}`);
    const out = parseOutput(r.stdout);
    assert.equal(
      out.hookSpecificOutput,
      undefined,
      'PreCompact must not emit hookSpecificOutput (rejected by schema)',
    );
    assert.deepEqual(out, {}, 'hook stdout must be an empty JSON object');
  } finally {
    r.cleanup();
  }
});

test('pre-compact stdin ignored: output identical regardless of stdin content', () => {
  const r1 = runHook(HOOK, { stdin: '' });
  const r2 = runHook(HOOK, { stdin: { some: 'ignored', stdin: 'content' } });
  try {
    assert.equal(r1.exitCode, 0);
    assert.equal(r2.exitCode, 0);
    assert.equal(r1.stdout.trim(), r2.stdout.trim(), 'output must be identical regardless of stdin');
  } finally {
    r1.cleanup();
    r2.cleanup();
  }
});

test('pre-compact writes nothing to plugin-data', () => {
  const r = runHook(HOOK, { stdin: '' });
  try {
    assert.equal(r.exitCode, 0);

    // plugin-data dir should contain only the harness-seeded bin/ (hook-runner
    // plants bin/.version to suppress the detached binary downloader) —
    // nothing written by this hook.
    const pdEntries = readdirSync(r.pluginDataDir).filter((n) => n !== 'bin');
    assert.deepEqual(pdEntries, [], `unexpected plugin-data files: ${pdEntries.join(', ')}`);

    // pre-compact is pure stdout — it has no file I/O in its source.
    // We verify this by checking the plugin-data dir (above).
    // We intentionally do not assert on r.tmpKeys here because concurrent test
    // files may legitimately create /tmp/learning-loop-* files and those appear
    // in this test's before/after delta through no fault of pre-compact.
  } finally {
    r.cleanup();
  }
});
