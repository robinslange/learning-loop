import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capLogFile } from '../plugin/scripts/lib/log-rotate.mjs';

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'll-logrotate-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('capLogFile leaves a file under the cap alone', () => {
  withDir((dir) => {
    const p = join(dir, 'watch.log');
    writeFileSync(p, 'line one\nline two\n');
    capLogFile(p, 1024);
    assert.equal(readFileSync(p, 'utf-8'), 'line one\nline two\n');
  });
});

test('capLogFile keeps the tail of an oversized file, not the head', () => {
  withDir((dir) => {
    const p = join(dir, 'watch.log');
    // 200 numbered lines; the newest are the ones worth keeping because the
    // only reader tails the last few after a failed daemon start.
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    writeFileSync(p, lines.join('\n') + '\n');
    const before = statSync(p).size;
    capLogFile(p, 512);
    const after = readFileSync(p, 'utf-8');
    assert.ok(statSync(p).size < before, 'file shrank');
    assert.ok(statSync(p).size <= 512, 'file is within the cap');
    assert.ok(after.includes('line 199'), 'newest line survives');
    assert.ok(!after.includes('line 0\n'), 'oldest line is gone');
  });
});

test('capLogFile starts each retained file on a whole line', () => {
  withDir((dir) => {
    const p = join(dir, 'watch.log');
    writeFileSync(p, Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n') + '\n');
    capLogFile(p, 512);
    const first = readFileSync(p, 'utf-8').split('\n')[0];
    assert.match(first, /^line \d+$/, 'no truncated partial line at the head');
  });
});

test('capLogFile is a no-op on a missing file', () => {
  withDir((dir) => {
    const p = join(dir, 'absent.log');
    capLogFile(p, 512);
    assert.equal(existsSync(p), false);
  });
});

test('capLogFile keeps the tail when it contains no newline at all', () => {
  withDir((dir) => {
    // A daemon that dies mid-write, or logs one very long line, leaves a tail
    // with no newline in it. Dropping to the first newline then wipes the file
    // to zero bytes and destroys the only diagnostic after a failed start --
    // the exact output the caller reads. Starting mid-line is the lesser loss.
    const p = join(dir, 'watch.log');
    writeFileSync(p, 'x'.repeat(5000));
    capLogFile(p, 1024);
    const after = readFileSync(p, 'utf-8');
    assert.ok(after.length > 0, 'a newline-free tail must not wipe the log');
    assert.ok(statSync(p).size <= 1024);
  });
});

test('capLogFile keeps the tail when only the head had newlines', () => {
  withDir((dir) => {
    const p = join(dir, 'watch.log');
    writeFileSync(p, 'header\n' + 'y'.repeat(5000));
    capLogFile(p, 1024);
    assert.ok(readFileSync(p, 'utf-8').length > 0, 'retained tail must survive');
  });
});

test('capLogFile does not wipe a tail made of multibyte characters', () => {
  withDir((dir) => {
    const p = join(dir, 'watch.log');
    writeFileSync(p, 'A'.repeat(2000) + '\n' + '🙂'.repeat(300));
    capLogFile(p, 1024);
    assert.ok(readFileSync(p, 'utf-8').length > 0, 'emoji tail must not wipe the log');
  });
});
