// tests/hook-stop-nudge.test.mjs
// Characterisation tests for hooks/stop-nudge.js
//
// Note: r.tmpKeys is unreliable under concurrent node --test workers — the
// before/after directory diff in hook-runner.mjs races against cleanup() from
// sibling test files, so a marker the hook *did* write can be missing from
// tmpKeys. We assert on stdout shape instead, which is captured by spawnSync
// and unaffected by cross-file /tmp races. Matches the pattern applied to
// hook-session-start.test.mjs in commit 2965635.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync, mkdtempSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
    // Marker-file presence is verified by the "already-nudged" test below,
    // which depends on the marker being written by the first call.
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
    // No need to assert on tmpKeys: empty stdout proves the hook hit an
    // early-exit path before reaching the writeFileSync(nudgeMarker) site.
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
    // Empty stdout proves the hook exited at the stop_hook_active guard before
    // any file-write side effect; tmpKeys check would be redundant + flaky.
  } finally {
    r.cleanup();
    rmSync(transcriptPath, { force: true });
  }
});

test('stop-nudge already-nudged: no second block output', () => {
  // Run the hook TWICE with the same transcript path.
  // The first call creates the nudge marker; the second call sees the marker and exits
  // without producing a second block. The dedup is the load-bearing assertion;
  // we verify it via the SECOND call's empty stdout, not via tmpKeys on the first
  // (tmpKeys races against sibling-file cleanup under parallel test workers).
  //
  // Both invocations share an isolated TMPDIR so the nudge marker (which the hook
  // writes to its tmpdir()) lives outside /tmp. Without this, sibling test files'
  // cleanup() — which sweeps /tmp/learning-loop-* files appearing during their
  // run — can delete our marker between r1 and r2 under concurrent test workers.
  const isolatedTmp = mkdtempSync(join(tmpdir(), 'll-stop-nudge-iso-'));
  const transcriptPath = join(isolatedTmp, `transcript-dedup-${Date.now()}.txt`);
  writeTranscript(transcriptPath, 60000);

  // First call: should block and write the nudge marker.
  const r1 = runHook(HOOK, {
    env: { TMPDIR: isolatedTmp },
    stdin: { session_id: 'test-dedup-first', transcript_path: transcriptPath, stop_hook_active: false },
  });
  try {
    assert.equal(r1.exitCode, 0);
    const out1 = r1.stdout.trim();
    assert.ok(out1.length > 0, 'first call must produce a block decision');
    assert.equal(JSON.parse(out1).decision, 'block');
  } catch (err) {
    r1.cleanup();
    rmSync(isolatedTmp, { recursive: true, force: true });
    throw err;
  }
  // Do NOT call r1.cleanup() yet — leave the nudge marker in isolatedTmp.

  // Second call with the same transcript path: marker exists → no second block.
  // This empty-stdout assertion implicitly proves the marker file was written
  // by r1; if it had not been, r2 would have emitted a second block.
  const r2 = runHook(HOOK, {
    env: { TMPDIR: isolatedTmp },
    stdin: { session_id: 'test-dedup-second', transcript_path: transcriptPath, stop_hook_active: false },
  });
  try {
    assert.equal(r2.exitCode, 0);
    assert.equal(r2.stdout.trim(), '', 'second call must not produce a second block (dedup)');
  } finally {
    r1.cleanup();
    r2.cleanup();
    rmSync(isolatedTmp, { recursive: true, force: true });
  }
});

test('reflect cooldown read from plugin-data suppresses the nudge — M2', () => {
  const transcriptPath = join(HOOK_TMP, `ll-test-transcript-cooldown-${Date.now()}.txt`);
  writeTranscript(transcriptPath, 60000);
  const r = runHook(HOOK, {
    stdin: { session_id: 'test-cooldown', transcript_path: transcriptPath, stop_hook_active: false },
    seed: (pluginDataDir) => {
      mkdirSync(join(pluginDataDir, 'markers'), { recursive: true });
      writeFileSync(
        join(pluginDataDir, 'markers', 'last-reflect'),
        String(Math.floor(Date.now() / 1000)),
      );
    },
  });
  try {
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout.trim(), '', 'fresh plugin-data last-reflect must suppress the nudge');
  } finally {
    r.cleanup();
    rmSync(transcriptPath, { force: true });
  }
});

test('dream nudge fires on >=3 new memories, then respects its once-guard — M3/M4', () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'll-sn-proj-'));
  const encodedPath = projectDir.replace(/[/\\]/g, '-');
  const sid = 'test-dream-nudge';

  const seed = (pluginDataDir, sandboxRoot) => {
    mkdirSync(join(pluginDataDir, 'markers'), { recursive: true });
    writeFileSync(join(pluginDataDir, 'markers', `memory-snapshot-${sid}`), '[]');
    const memDir = join(sandboxRoot, '.claude', 'projects', encodedPath, 'memory');
    mkdirSync(memDir, { recursive: true });
    for (const n of ['a.md', 'b.md', 'c.md']) writeFileSync(join(memDir, n), '# x');
  };

  const r1 = runHook(HOOK, {
    env: { CLAUDE_PROJECT_DIR: projectDir },
    stdin: { session_id: sid, transcript_path: '/nonexistent', stop_hook_active: false },
    seed,
  });
  try {
    assert.equal(r1.exitCode, 0, r1.stderr);
    const out = r1.stdout.trim();
    assert.ok(out.length > 0, 'first stop with 3 new memories must nudge');
    const parsed = JSON.parse(out);
    assert.equal(parsed.decision, 'block');
    assert.match(parsed.reason, /\/dream/);
    assert.ok(
      existsSync(join(r1.pluginDataDir, 'markers', 'dream-nudged')),
      'first nudge must write the once-guard marker',
    );
  } finally {
    r1.cleanup();
  }

  // Second run: pre-existing dream-nudged marker for the SAME session id must
  // suppress the nudge (M3 — the marker is finally read). transcript_path
  // /nonexistent makes the fallback transcript check exit silently.
  const r2 = runHook(HOOK, {
    env: { CLAUDE_PROJECT_DIR: projectDir },
    stdin: { session_id: sid, transcript_path: '/nonexistent', stop_hook_active: false },
    seed: (pluginDataDir, sandboxRoot) => {
      seed(pluginDataDir, sandboxRoot);
      writeFileSync(
        join(pluginDataDir, 'markers', 'dream-nudged'),
        JSON.stringify({ ts: Math.floor(Date.now() / 1000), session_id: sid }),
      );
    },
  });
  try {
    assert.equal(r2.exitCode, 0, r2.stderr);
    assert.equal(r2.stdout.trim(), '', 'dream-nudged once-guard must suppress the second nudge');
  } finally {
    r2.cleanup();
  }

  // Third run: a fresh dream-nudged marker from a DIFFERENT session must NOT
  // suppress — the guard is once-per-SESSION, not once-per-cooldown-window. A
  // mutant that ignores session_id and suppresses on the ts cooldown alone
  // would pass r1/r2 but fail here.
  const r3 = runHook(HOOK, {
    env: { CLAUDE_PROJECT_DIR: projectDir },
    stdin: { session_id: sid, transcript_path: '/nonexistent', stop_hook_active: false },
    seed: (pluginDataDir, sandboxRoot) => {
      seed(pluginDataDir, sandboxRoot);
      writeFileSync(
        join(pluginDataDir, 'markers', 'dream-nudged'),
        JSON.stringify({ ts: Math.floor(Date.now() / 1000), session_id: 'other-session' }),
      );
    },
  });
  try {
    assert.equal(r3.exitCode, 0, r3.stderr);
    const out3 = r3.stdout.trim();
    assert.ok(
      out3.length > 0,
      "another session's dream-nudged marker must not suppress this session's nudge",
    );
    const parsed3 = JSON.parse(out3);
    assert.equal(parsed3.decision, 'block');
    assert.match(parsed3.reason, /\/dream/);
  } finally {
    r3.cleanup();
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// Regression (W5/6d): when the once-guard marker write FAILS, the dream
// nudge must be suppressed, not emitted. Emitting without a persisted guard
// re-nudges on every later stop of the session (the guard never exists). The
// at-most-once contract wins: a guard-write failure costs at most one missed
// advisory nudge, and the realistic broken-plugin-data case can't reach this
// branch anyway (the memory snapshot could not have been written either).
// writeMarker's own logError records the failure.
test('dream nudge suppressed when the once-guard write fails — W5/6d', () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'll-sn-guardfail-'));
  const encodedPath = projectDir.replace(/[/\\]/g, '-');
  const sid = 'test-guard-fail';

  const r = runHook(HOOK, {
    env: { CLAUDE_PROJECT_DIR: projectDir },
    stdin: { session_id: sid, transcript_path: '/nonexistent', stop_hook_active: false },
    seed: (pluginDataDir, sandboxRoot) => {
      const markersDir = join(pluginDataDir, 'markers');
      mkdirSync(markersDir, { recursive: true });
      writeFileSync(join(markersDir, `memory-snapshot-${sid}`), '[]');
      const memDir = join(sandboxRoot, '.claude', 'projects', encodedPath, 'memory');
      mkdirSync(memDir, { recursive: true });
      for (const n of ['a.md', 'b.md', 'c.md']) writeFileSync(join(memDir, n), '# x');
      // Read-only markers dir: the snapshot read still works, but the
      // once-guard writeMarker fails with EACCES.
      chmodSync(markersDir, 0o555);
    },
  });
  try {
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(
      r.stdout.trim(),
      '',
      'an unpersisted once-guard must suppress the dream nudge (at-most-once contract)',
    );
  } finally {
    try {
      chmodSync(join(r.pluginDataDir, 'markers'), 0o755);
    } catch {}
    r.cleanup();
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test('stop-nudge empty stdin: exits 0 silently', () => {
  const r = runHook(HOOK, { stdin: '' });
  try {
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout.trim(), '');
    // Empty stdin exits at line 24 before any file I/O. Empty stdout proves
    // the hook never reached the writeFileSync site.
  } finally {
    r.cleanup();
  }
});
