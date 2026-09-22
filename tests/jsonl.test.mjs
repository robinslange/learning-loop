import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendJsonlLine,
  appendJsonlLineSafe,
  appendJsonlLineDeduped,
  readTailBytes,
  _dedupeStats,
  _resetDedupeCache,
  _lastWrittenSize,
} from '../plugin/scripts/lib/jsonl.mjs';

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'll-jsonl-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('appendJsonlLine writes one well-formed line per call', () => {
  withTempDir((dir) => {
    const path = join(dir, 'events.jsonl');
    appendJsonlLine(path, { a: 1 });
    appendJsonlLine(path, { b: 'two' });
    appendJsonlLine(path, { c: [3, 4, 5] });
    const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 3);
    assert.deepStrictEqual(JSON.parse(lines[0]), { a: 1 });
    assert.deepStrictEqual(JSON.parse(lines[1]), { b: 'two' });
    assert.deepStrictEqual(JSON.parse(lines[2]), { c: [3, 4, 5] });
  });
});

test('appendJsonlLine creates parent directories as needed', () => {
  withTempDir((dir) => {
    const path = join(dir, 'nested', 'deep', 'events.jsonl');
    appendJsonlLine(path, { ok: true });
    assert.deepStrictEqual(JSON.parse(readFileSync(path, 'utf-8').trim()), { ok: true });
  });
});

test('appendJsonlLine appends to existing file without truncation', () => {
  withTempDir((dir) => {
    const path = join(dir, 'log.jsonl');
    writeFileSync(path, '{"existing":true}\n');
    appendJsonlLine(path, { added: 1 });
    const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 2);
    assert.deepStrictEqual(JSON.parse(lines[0]), { existing: true });
    assert.deepStrictEqual(JSON.parse(lines[1]), { added: 1 });
  });
});

test('concurrent appends produce parseable lines (no byte interleave)', async () => {
  await withTempDirAsync(async (dir) => {
    const path = join(dir, 'concurrent.jsonl');
    const N = 200;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        Promise.resolve().then(() => appendJsonlLine(path, { i, payload: 'x'.repeat(50) })),
      ),
    );
    const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
    assert.strictEqual(lines.length, N);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      assert.ok(typeof parsed.i === 'number');
      assert.strictEqual(parsed.payload, 'x'.repeat(50));
    }
  });
});

test('appendJsonlLineSafe returns false on unwritable path instead of throwing', () => {
  // A regular file used as a parent directory: mkdir/open under it fails on
  // every platform (an absolute path under '/' is creatable on Windows, so it
  // can't stand in for "unwritable").
  const dir = mkdtempSync(join(tmpdir(), 'll-jsonl-'));
  try {
    const file = join(dir, 'not-a-dir');
    writeFileSync(file, 'x');
    const result = appendJsonlLineSafe(join(file, 'child.jsonl'), { a: 1 });
    assert.strictEqual(result, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function withTempDirAsync(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'll-jsonl-'));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// appendJsonlLineDeduped compares the incoming record (minus `ts`) against
// the LAST LINE ALREADY ON DISK, and compares the caller-supplied `now` for
// the second call against the first record's own `ts` (parsed). This makes
// the 2s window deterministic without real sleeps: tests control both the
// first record's `ts` string and the second call's `now` epoch directly, so
// "elapsed time" is just arithmetic, never a wall-clock wait.
const T0 = Date.parse('2026-05-01T00:00:00.000Z');

test('appendJsonlLineDeduped: identical payload twice within 2s writes one line', () => {
  withTempDir((dir) => {
    const path = join(dir, 'dedup.jsonl');
    const record = {
      ts: new Date(T0).toISOString(),
      agent: 'note-verifier',
      action: 'score',
      target: 'a.md',
      result: 'pass',
    };
    appendJsonlLineDeduped(path, record, T0);
    appendJsonlLineDeduped(path, { ...record, ts: new Date(T0 + 500).toISOString() }, T0 + 500);
    const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 1, 'exact duplicate within window must write once');
  });
});

test('appendJsonlLineDeduped: different payload back-to-back writes two lines', () => {
  withTempDir((dir) => {
    const path = join(dir, 'dedup.jsonl');
    const record = {
      ts: new Date(T0).toISOString(),
      agent: 'note-verifier',
      action: 'score',
      target: 'a.md',
      result: 'pass',
    };
    appendJsonlLineDeduped(path, record, T0);
    appendJsonlLineDeduped(
      path,
      { ...record, target: 'b.md', ts: new Date(T0 + 500).toISOString() },
      T0 + 500,
    );
    const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 2, 'a different payload must not be suppressed');
  });
});

test('appendJsonlLineDeduped: identical payload after >2s writes two lines', () => {
  withTempDir((dir) => {
    const path = join(dir, 'dedup.jsonl');
    const record = {
      ts: new Date(T0).toISOString(),
      agent: 'note-verifier',
      action: 'score',
      target: 'a.md',
      result: 'pass',
    };
    appendJsonlLineDeduped(path, record, T0);
    appendJsonlLineDeduped(path, { ...record, ts: new Date(T0 + 3500).toISOString() }, T0 + 3500);
    const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
    assert.strictEqual(
      lines.length,
      2,
      'the 2s window must have elapsed, so this is not a duplicate',
    );
  });
});

// agent-result records have no field that distinguishes one subagent's
// completion from another's (session_id and transcript_path are identical
// for every subagent in a session). Two distinct subagents finishing within
// the dedup window is the modal case for parallel dispatch, not a rare edge
// case -- dedup must never suppress the second one.
test('appendJsonlLineDeduped: agent-result is exempt from dedup, even with identical payload within 2s', () => {
  withTempDir((dir) => {
    const path = join(dir, 'dedup.jsonl');
    const record = {
      ts: new Date(T0).toISOString(),
      action: 'agent-result',
      session_id: 's',
      transcript_path: 't',
    };
    appendJsonlLineDeduped(path, record, T0);
    appendJsonlLineDeduped(path, { ...record, ts: new Date(T0 + 500).toISOString() }, T0 + 500);
    const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
    assert.strictEqual(
      lines.length,
      2,
      'agent-result must always be written, even if identical to the prior line',
    );
  });
});

// agent-spawn and skill-invoke are the other two provenance fan-out actions:
// a uniform parallel dispatch (three Explore agents, same description; the same
// skill invoked twice) emits byte-identical payloads bar `ts`. They carry no
// field that separates one call from the next, so the same reasoning that
// exempts agent-result applies -- dedup must not collapse a real fan-out into
// one line and undercount volume in the provenance report.
for (const action of ['agent-spawn', 'skill-invoke']) {
  test(`appendJsonlLineDeduped: ${action} is exempt from dedup, even with identical payload within 2s`, () => {
    withTempDir((dir) => {
      const path = join(dir, 'dedup.jsonl');
      const record =
        action === 'agent-spawn'
          ? {
              ts: new Date(T0).toISOString(),
              action,
              agent: 'Explore',
              description: 'search the codebase',
              background: true,
            }
          : { ts: new Date(T0).toISOString(), action, skill: 'verify', args: 'inbox' };
      appendJsonlLineDeduped(path, record, T0);
      appendJsonlLineDeduped(path, { ...record, ts: new Date(T0 + 500).toISOString() }, T0 + 500);
      const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
      assert.strictEqual(
        lines.length,
        2,
        `${action} must always be written, even if identical to the prior line`,
      );
    });
  });
}

test('session-summary records are never deduplicated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-jsonl-ledger-'));
  try {
    const file = join(dir, 'events.jsonl');
    const rec = {
      ts: '2026-09-21T00:00:00Z',
      action: 'session-summary',
      session_id: 's',
      prompts: 3,
    };
    assert.equal(appendJsonlLineDeduped(file, rec), true);
    assert.equal(appendJsonlLineDeduped(file, { ...rec, ts: '2026-09-21T00:00:01Z' }), true);
    assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The in-process fingerprint cache (plan 1d) exists so a long-lived process
// never tails the same file twice: the first deduped append for a path seeds
// the cache from disk (one lastLine call), and every later call against that
// path answers from memory. This is the property that distinguishes "an
// in-memory cache" from "reading the disk tail on every emit" -- assert the
// call count, not just the resulting content.
test('appendJsonlLineDeduped: two deduped appends of identical content read the disk tail at most once', () => {
  withTempDir((dir) => {
    _resetDedupeCache();
    const path = join(dir, 'dedup.jsonl');
    const record = {
      ts: new Date(T0).toISOString(),
      agent: 'note-verifier',
      action: 'score',
      target: 'a.md',
      result: 'pass',
    };
    appendJsonlLineDeduped(path, record, T0);
    appendJsonlLineDeduped(path, { ...record, ts: new Date(T0 + 500).toISOString() }, T0 + 500);
    appendJsonlLineDeduped(path, { ...record, ts: new Date(T0 + 900).toISOString() }, T0 + 900);
    const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 1, 'three identical appends within the window write once');
    assert.strictEqual(
      _dedupeStats().lastLineCalls,
      1,
      'the first call misses the in-memory cache and tails the (nonexistent) file once; every ' +
        'later call for the same path must answer from the in-memory fingerprint, not disk',
    );
  });
});

// Paths are monthly stream files in practice, so this map stays tiny -- but
// nothing enforced that, so a caller that churned through many distinct
// paths would have grown it without bound.
test('appendJsonlLineDeduped: the lastWritten cache is bounded, evicting the oldest path', () => {
  withTempDir((dir) => {
    _resetDedupeCache();
    const record = { agent: 'x', action: 'score', target: 'a.md', result: 'pass' };
    const pathFor = (i) => join(dir, `stream-${i}.jsonl`);
    for (let i = 0; i < 40; i++) {
      appendJsonlLineDeduped(pathFor(i), { ...record, ts: new Date(T0 + i).toISOString() }, T0 + i);
    }
    assert.ok(
      _lastWrittenSize() <= 32,
      `expected the cache capped at 32, got ${_lastWrittenSize()}`,
    );
    // The oldest path (stream-0) was evicted, so a repeat call for it misses
    // the in-memory cache and tails the (empty) file again rather than
    // dedupe-suppressing off a fingerprint that should have aged out.
    const before = _dedupeStats().lastLineCalls;
    appendJsonlLineDeduped(
      pathFor(0),
      { ...record, ts: new Date(T0 + 1000).toISOString() },
      T0 + 1000,
    );
    assert.strictEqual(_dedupeStats().lastLineCalls, before + 1, 'evicted path must re-read disk');
  });
});

test('readTailBytes: truncated is false when the whole file fits in maxBytes', () => {
  withTempDir((dir) => {
    const path = join(dir, 'small.jsonl');
    writeFileSync(path, '{"a":1}\n{"b":2}\n');
    const { text, truncated } = readTailBytes(path, 4096);
    assert.strictEqual(text, '{"a":1}\n{"b":2}\n');
    assert.strictEqual(truncated, false);
  });
});

test('readTailBytes: truncated is true when the read starts past byte 0', () => {
  withTempDir((dir) => {
    const path = join(dir, 'big.jsonl');
    writeFileSync(path, '{"a":1}\n{"b":2}\n{"c":3}\n');
    const { text, truncated } = readTailBytes(path, 8);
    assert.strictEqual(truncated, true);
    assert.ok(text.length <= 8);
  });
});
