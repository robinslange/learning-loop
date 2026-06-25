import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendJsonlLine, appendJsonlLineSafe } from '../plugin/scripts/lib/jsonl.mjs';

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
