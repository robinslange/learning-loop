// tests/hook-stop-nudge.test.mjs
// Characterisation tests for hooks/stop-nudge.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { runHook } from './helpers/hook-runner.mjs';

const HOOK = new URL('../hooks/stop-nudge.js', import.meta.url).pathname;

// On macOS, the hook child uses /tmp (the symlink) as its tmpdir().
// Use this consistent path for pre-seeded markers and cleanup.
const HOOK_TMP = '/tmp';

// Write a transcript of exactly `size` bytes to `path`.
function writeTranscript(path, size) {
  writeFileSync(path, Buffer.alloc(size, 'a'));
}

test('stop-nudge long transcript: decision=block with substantial session reason', () => {
  const transcriptPath = join(HOOK_TMP, `ll-test-transcript-long-${Date.now()}.txt`);
  writeTranscript(transcriptPath, 60000);

  const pathHash = createHash('md5').update(transcriptPath).digest('hex');
  const markerKey = `learning-loop-stop-nudged-${pathHash}`;

  const r = runHook(HOOK, {
    stdin: { session_id: 'test-long', transcript_path: transcriptPath, stop_hook_active: false },
  });
  try {
    assert.equal(r.exitCode, 0, `unexpected exit code: ${r.exitCode}, stderr: ${r.stderr}`);

    const out = r.stdout.trim();
    assert.ok(out.length > 0, 'should produce output for long transcript');
    const parsed = JSON.parse(out);
    assert.equal(parsed.decision, 'block');
    assert.match(parsed.reason, /substantial/i);

    // Marker file should appear in tmpKeys.
    assert.ok(r.tmpKeys.includes(markerKey), `expected nudge marker in tmpKeys.\ntmpKeys: ${JSON.stringify(r.tmpKeys)}`);
  } finally {
    r.cleanup();
    rmSync(transcriptPath, { force: true });
  }
});

test('stop-nudge short transcript: exits 0, empty stdout, no nudge marker', () => {
  const transcriptPath = join(HOOK_TMP, `ll-test-transcript-short-${Date.now()}.txt`);
  writeTranscript(transcriptPath, 1024);

  const r = runHook(HOOK, {
    stdin: { session_id: 'test-short', transcript_path: transcriptPath, stop_hook_active: false },
  });
  try {
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout.trim(), '', 'short transcript should produce no stdout');
    // No nudge marker written.
    assert.ok(
      r.tmpKeys.every((k) => !k.startsWith('learning-loop-stop-nudged-')),
      `unexpected nudge marker: ${r.tmpKeys.join(', ')}`,
    );
  } finally {
    r.cleanup();
    rmSync(transcriptPath, { force: true });
  }
});

test('stop-nudge stop_hook_active=true: immediate exit 0, no output', () => {
  const transcriptPath = join(HOOK_TMP, `ll-test-transcript-active-${Date.now()}.txt`);
  writeTranscript(transcriptPath, 60000);

  const r = runHook(HOOK, {
    stdin: { session_id: 'test-active', transcript_path: transcriptPath, stop_hook_active: true },
  });
  try {
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout.trim(), '', 'stop_hook_active should suppress all output');
    assert.ok(
      r.tmpKeys.every((k) => !k.startsWith('learning-loop-stop-nudged-')),
      `unexpected nudge marker when stop_hook_active`,
    );
  } finally {
    r.cleanup();
    rmSync(transcriptPath, { force: true });
  }
});

test('stop-nudge already-nudged: no second block output', () => {
  // Run the hook TWICE with the same transcript path.
  // The first call creates the nudge marker; the second call sees the marker and exits
  // without producing a second block. We do not pre-seed the marker from outside
  // the hook because doing so via the shared /tmp would race with concurrent test files
  // (session-start's runHook cleanup scans /tmp and could inadvertently remove it).
  const transcriptPath = join(HOOK_TMP, `ll-test-transcript-dedup-${Date.now()}.txt`);
  writeTranscript(transcriptPath, 60000);

  const pathHash = createHash('md5').update(transcriptPath).digest('hex');
  const markerKey = `learning-loop-stop-nudged-${pathHash}`;

  // First call: should block and write the nudge marker.
  const r1 = runHook(HOOK, {
    stdin: { session_id: 'test-dedup-first', transcript_path: transcriptPath, stop_hook_active: false },
  });
  try {
    assert.equal(r1.exitCode, 0);
    const out1 = r1.stdout.trim();
    assert.ok(out1.length > 0, 'first call must produce a block decision');
    assert.equal(JSON.parse(out1).decision, 'block');
    // Marker must be present so the second call sees it.
    assert.ok(
      r1.tmpKeys.includes(markerKey),
      `nudge marker not in tmpKeys after first call; got: ${r1.tmpKeys.join(', ')}`,
    );
  } catch (err) {
    r1.cleanup();
    rmSync(transcriptPath, { force: true });
    throw err;
  }
  // Do NOT call r1.cleanup() yet — leave the nudge marker in /tmp.

  // Second call with the same transcript path: marker exists → no second block.
  const r2 = runHook(HOOK, {
    stdin: { session_id: 'test-dedup-second', transcript_path: transcriptPath, stop_hook_active: false },
  });
  try {
    assert.equal(r2.exitCode, 0);
    assert.equal(r2.stdout.trim(), '', 'second call must not produce a second block (dedup)');
  } finally {
    r1.cleanup();
    r2.cleanup();
    rmSync(transcriptPath, { force: true });
  }
});

test('stop-nudge empty stdin: exits 0 silently', () => {
  const r = runHook(HOOK, { stdin: '' });
  try {
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout.trim(), '');
    // Empty stdin exits before any file I/O; no stop-nudge marker should be written.
    // We don't assert r.tmpKeys is entirely empty because concurrent test files
    // may create unrelated /tmp/learning-loop-* files.
    const nudgeKeys = r.tmpKeys.filter((k) => k.startsWith('learning-loop-stop-nudged-'));
    assert.deepEqual(nudgeKeys, [], `empty stdin must not create a nudge marker: ${nudgeKeys.join(', ')}`);
  } finally {
    r.cleanup();
  }
});
