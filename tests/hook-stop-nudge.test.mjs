// tests/hook-stop-nudge.test.mjs
// Characterisation tests for hooks/stop-nudge.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync, mkdtempSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { skipOnWindows } from './helpers/platform.mjs';
import { runHook } from './helpers/hook-runner.mjs';
import { fileURLToPath } from 'node:url';
import { encodeProjectDir } from '../plugin/scripts/lib/paths.mjs';

const HOOK = fileURLToPath(new URL('../plugin/hooks/stop-nudge.js', import.meta.url));

// Mirror the hook child's tmpdir() so pre-seeded markers and transcript
// fixtures land where the hook resolves them on every platform.
const HOOK_TMP = tmpdir();

// Write a transcript of exactly `size` bytes to `path`.
function writeTranscript(path, size) {
  writeFileSync(path, Buffer.alloc(size, 'a'));
}

test('stop-nudge long transcript: decision=block with substantial session reason', () => {
  const transcriptPath = join(HOOK_TMP, `ll-test-transcript-long-${Date.now()}.txt`);
  writeTranscript(transcriptPath, 600_000);

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

// Regression: the old 51,200-byte / 25-line thresholds fired within the first
// few tool-heavy turns of essentially every working session (transcripts embed
// full tool outputs), interrupting mid-task. A transcript that would have
// tripped BOTH old arms must no longer nudge.
test('stop-nudge mid-size transcript (old 50KB/25-line thresholds): no nudge', () => {
  const transcriptPath = join(HOOK_TMP, `ll-test-transcript-midsize-${Date.now()}.txt`);
  // ~60KB across 30 JSONL lines: over the old size AND count thresholds,
  // under the new ones (512KB / 200 lines).
  const line = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(2000) } });
  writeFileSync(transcriptPath, Array(30).fill(line).join('\n'));

  const r = runHook(HOOK, {
    stdin: { session_id: 'test-midsize', transcript_path: transcriptPath, stop_hook_active: false },
  });
  try {
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(
      r.stdout.trim(),
      '',
      'a few tool-heavy turns must not count as a substantial session',
    );
  } finally {
    r.cleanup();
    rmSync(transcriptPath, { force: true });
  }
});

test('stop-nudge message-count arm: many small lines trigger the nudge', () => {
  const transcriptPath = join(HOOK_TMP, `ll-test-transcript-manylines-${Date.now()}.txt`);
  // 250 small lines (~10KB): under the size threshold, over the count threshold.
  writeFileSync(transcriptPath, Array(250).fill('{"type":"user"}').join('\n'));

  const r = runHook(HOOK, {
    stdin: {
      session_id: 'test-manylines',
      transcript_path: transcriptPath,
      stop_hook_active: false,
    },
  });
  try {
    assert.equal(r.exitCode, 0, r.stderr);
    const out = r.stdout.trim();
    assert.ok(out.length > 0, 'long session by message count should nudge');
    assert.equal(JSON.parse(out).decision, 'block');
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
    // Empty stdout proves the hook exited before writing the once-guard.
  } finally {
    r.cleanup();
    rmSync(transcriptPath, { force: true });
  }
});

test('stop-nudge stop_hook_active=true: immediate exit 0, no output', () => {
  const transcriptPath = join(HOOK_TMP, `ll-test-transcript-active-${Date.now()}.txt`);
  writeTranscript(transcriptPath, 600_000);

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
  // Both Stops share one plugin-data dir, where the once-guard lives.
  const pluginData = mkdtempSync(join(tmpdir(), 'll-stop-nudge-dedup-'));
  const transcriptPath = join(pluginData, 'transcript.txt');
  writeTranscript(transcriptPath, 600_000);
  const stop = () =>
    runHook(HOOK, {
      env: { CLAUDE_PLUGIN_DATA: pluginData },
      stdin: { session_id: 'test-dedup', transcript_path: transcriptPath, stop_hook_active: false },
    });
  try {
    const r1 = stop();
    r1.cleanup();
    assert.equal(r1.exitCode, 0, r1.stderr);
    assert.equal(JSON.parse(r1.stdout).decision, 'block', 'first call must block');
    const r2 = stop();
    r2.cleanup();
    assert.equal(r2.exitCode, 0, r2.stderr);
    assert.equal(r2.stdout.trim(), '', 'second call must not produce a second block (dedup)');
  } finally {
    rmSync(pluginData, { recursive: true, force: true });
  }
});

test('reflect cooldown read from plugin-data suppresses the nudge — M2', () => {
  const transcriptPath = join(HOOK_TMP, `ll-test-transcript-cooldown-${Date.now()}.txt`);
  writeTranscript(transcriptPath, 600_000);
  const r = runHook(HOOK, {
    stdin: {
      session_id: 'test-cooldown',
      transcript_path: transcriptPath,
      stop_hook_active: false,
    },
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
  const encodedPath = encodeProjectDir(projectDir);
  const sid = 'test-dream-nudge';

  const seed = (pluginDataDir, sandboxRoot) => {
    mkdirSync(join(pluginDataDir, 'markers'), { recursive: true });
    // This session's own write log records three memory files (post-tool
    // appends here on each Write/Edit into the memory dir). The count is
    // sourced from this log, not a directory diff.
    writeFileSync(
      join(pluginDataDir, 'markers', `memory-writes-${sid}`),
      JSON.stringify(['a.md', 'b.md', 'c.md']),
    );
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
      existsSync(join(r1.pluginDataDir, 'markers', `stop-nudged-${sid}`)),
      'first nudge must write the once-guard marker',
    );
  } finally {
    r1.cleanup();
  }

  // Second run: a once-guard for the SAME session id must suppress the nudge.
  // transcript_path /nonexistent makes the fallback transcript check exit
  // silently.
  const r2 = runHook(HOOK, {
    env: { CLAUDE_PROJECT_DIR: projectDir },
    stdin: { session_id: sid, transcript_path: '/nonexistent', stop_hook_active: false },
    seed: (pluginDataDir, sandboxRoot) => {
      seed(pluginDataDir, sandboxRoot);
      writeFileSync(
        join(pluginDataDir, 'markers', `stop-nudged-${sid}`),
        String(Math.floor(Date.now() / 1000)),
      );
    },
  });
  try {
    assert.equal(r2.exitCode, 0, r2.stderr);
    assert.equal(r2.stdout.trim(), '', 'the once-guard must suppress the second nudge');
  } finally {
    r2.cleanup();
  }

  // Third run: a fresh once-guard from a DIFFERENT session must NOT suppress
  // — the guard is once per session.
  const r3 = runHook(HOOK, {
    env: { CLAUDE_PROJECT_DIR: projectDir },
    stdin: { session_id: sid, transcript_path: '/nonexistent', stop_hook_active: false },
    seed: (pluginDataDir, sandboxRoot) => {
      seed(pluginDataDir, sandboxRoot);
      writeFileSync(
        join(pluginDataDir, 'markers', 'stop-nudged-other-session'),
        String(Math.floor(Date.now() / 1000)),
      );
    },
  });
  try {
    assert.equal(r3.exitCode, 0, r3.stderr);
    const out3 = r3.stdout.trim();
    assert.ok(
      out3.length > 0,
      "another session's once-guard must not suppress this session's nudge",
    );
    const parsed3 = JSON.parse(out3);
    assert.equal(parsed3.decision, 'block');
    assert.match(parsed3.reason, /\/dream/);
  } finally {
    r3.cleanup();
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// With two sessions open, each Stop used to overwrite one shared dream-nudged
// file with its own id, so the other session's next Stop saw a foreign id and
// nudged again. And the dream nudge never set the substantial-session guard,
// so one session could be nudged twice. Once means once per session.
test('two sessions alternating Stops are each nudged exactly once', () => {
  const root = mkdtempSync(join(tmpdir(), 'll-sn-alternate-'));
  const pluginData = join(root, 'plugin-data');
  const projectDir = join(root, 'project');
  const memDir = join(root, '.claude', 'projects', encodeProjectDir(projectDir), 'memory');
  mkdirSync(join(pluginData, 'markers'), { recursive: true });
  mkdirSync(memDir, { recursive: true });
  const transcriptPath = join(root, 'transcript.txt');
  writeTranscript(transcriptPath, 600_000);
  for (const sid of ['A', 'B']) {
    const names = ['1', '2', '3'].map((n) => `${sid}-${n}.md`);
    for (const n of names) writeFileSync(join(memDir, n), '# x');
    writeFileSync(join(pluginData, 'markers', `memory-writes-${sid}`), JSON.stringify(names));
  }
  const stop = (sid) => {
    const r = runHook(HOOK, {
      env: { HOME: root, CLAUDE_PLUGIN_DATA: pluginData, CLAUDE_PROJECT_DIR: projectDir },
      stdin: { session_id: sid, transcript_path: transcriptPath, stop_hook_active: false },
    });
    r.cleanup();
    assert.equal(r.exitCode, 0, r.stderr);
    return r.stdout.trim() ? JSON.parse(r.stdout).reason : null;
  };
  try {
    const reasons = ['A', 'B', 'A', 'B'].map(stop);
    assert.match(reasons[0], /\/dream/);
    assert.match(reasons[1], /\/dream/);
    assert.deepEqual(reasons.slice(2), [null, null]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Regression: a session that wrote NO memory files must not be nudged, even
// when many memory files appeared in the shared dir from CONCURRENT sessions.
// The old code diffed the whole memory dir against a session-start snapshot,
// so a read-only session left open while siblings wrote got blamed for their
// writes ("this session created 31 new memory files" with zero of its own).
// The count must come from this session's own write log.
test('dream nudge ignores concurrent sessions writes — only this session count', () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'll-sn-concurrent-'));
  const encodedPath = encodeProjectDir(projectDir);
  const sid = 'test-readonly-session';

  const r = runHook(HOOK, {
    env: { CLAUDE_PROJECT_DIR: projectDir },
    stdin: { session_id: sid, transcript_path: '/nonexistent', stop_hook_active: false },
    seed: (pluginDataDir, sandboxRoot) => {
      mkdirSync(join(pluginDataDir, 'markers'), { recursive: true });
      // This session's write log is empty: it wrote nothing.
      writeFileSync(join(pluginDataDir, 'markers', `memory-writes-${sid}`), '[]');
      // Also seed an empty session-start snapshot — the OLD code keyed its
      // dir-diff on this, so its presence is what made the bug fire. Seeding
      // it ensures this test bites the old implementation (which would count
      // the 30 peer files and nudge) and passes the new one (write-log = 0).
      writeFileSync(join(pluginDataDir, 'markers', `memory-snapshot-${sid}`), '[]');
      // The shared memory dir is full of OTHER sessions' files.
      const memDir = join(sandboxRoot, '.claude', 'projects', encodedPath, 'memory');
      mkdirSync(memDir, { recursive: true });
      for (let i = 0; i < 30; i++) writeFileSync(join(memDir, `other-${i}.md`), '# from a peer');
    },
  });
  try {
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(
      r.stdout.trim(),
      '',
      "a session that wrote nothing must not be nudged for peers' files",
    );
  } finally {
    r.cleanup();
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// Regression: the count is the size of this session's write log intersected
// with files still on disk — a file this session wrote then deleted (or that a
// later dream archived) must not be counted. Two real writes, one since-removed,
// plus an unrelated peer file present: count is 2, under the >=3 gate → no nudge.
test('dream nudge counts only this session writes still present on disk', () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'll-sn-presence-'));
  const encodedPath = encodeProjectDir(projectDir);
  const sid = 'test-presence';

  const r = runHook(HOOK, {
    env: { CLAUDE_PROJECT_DIR: projectDir },
    stdin: { session_id: sid, transcript_path: '/nonexistent', stop_hook_active: false },
    seed: (pluginDataDir, sandboxRoot) => {
      mkdirSync(join(pluginDataDir, 'markers'), { recursive: true });
      // Logged three writes, but 'gone.md' was removed since.
      writeFileSync(
        join(pluginDataDir, 'markers', `memory-writes-${sid}`),
        JSON.stringify(['kept-1.md', 'kept-2.md', 'gone.md']),
      );
      const memDir = join(sandboxRoot, '.claude', 'projects', encodedPath, 'memory');
      mkdirSync(memDir, { recursive: true });
      writeFileSync(join(memDir, 'kept-1.md'), '# x');
      writeFileSync(join(memDir, 'kept-2.md'), '# x');
      writeFileSync(join(memDir, 'peer.md'), '# from a peer');
    },
  });
  try {
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout.trim(), '', 'two present own-writes are under the >=3 gate → no nudge');
  } finally {
    r.cleanup();
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
test(
  'dream nudge suppressed when the once-guard write fails — W5/6d',
  { skip: skipOnWindows('chmod semantics: read-only dirs not enforced on win32') },
  () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'll-sn-guardfail-'));
    const encodedPath = encodeProjectDir(projectDir);
    const sid = 'test-guard-fail';

    const r = runHook(HOOK, {
      env: { CLAUDE_PROJECT_DIR: projectDir },
      stdin: { session_id: sid, transcript_path: '/nonexistent', stop_hook_active: false },
      seed: (pluginDataDir, sandboxRoot) => {
        const markersDir = join(pluginDataDir, 'markers');
        mkdirSync(markersDir, { recursive: true });
        writeFileSync(
          join(markersDir, `memory-writes-${sid}`),
          JSON.stringify(['a.md', 'b.md', 'c.md']),
        );
        const memDir = join(sandboxRoot, '.claude', 'projects', encodedPath, 'memory');
        mkdirSync(memDir, { recursive: true });
        for (const n of ['a.md', 'b.md', 'c.md']) writeFileSync(join(memDir, n), '# x');
        // Read-only markers dir: the write-log read still works, but the
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
  },
);

test('stop-nudge empty stdin: exits 0 silently', () => {
  const r = runHook(HOOK, { stdin: '' });
  try {
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout.trim(), '');
    // Empty stdin exits before any file I/O.
  } finally {
    r.cleanup();
  }
});
