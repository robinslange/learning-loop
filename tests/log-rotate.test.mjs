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

// The three cases below all end with capLogFile destroying or overrunning the
// thing it exists to bound. The reader tails this file after a failed daemon
// start, so an empty log is worse than an uncapped one: it removes the only
// evidence of the failure the caller came for.

test('capLogFile keeps the tail when its only newline is the final byte', () => {
  withDir((dir) => {
    const p = join(dir, 'watch.log');
    // One very long line with a trailing newline. The retained window holds
    // exactly one newline, at its end, so slicing past it leaves nothing.
    writeFileSync(p, 'x'.repeat(400) + '\n');
    capLogFile(p, 100);
    const after = readFileSync(p);
    assert.ok(after.length > 0, 'the log the caller reads after a failed start survives');
    assert.ok(after.length <= 100, 'and stays within the cap');
  });
});

test('capLogFile respects the cap when the tail holds undecodable bytes', () => {
  withDir((dir) => {
    const p = join(dir, 'watch.log');
    // watch.log is raw daemon stdout/stderr. Decoding to a string first turns
    // each invalid byte into a 3-byte U+FFFD, so the write can exceed the cap
    // the caller asked for: 5000 x 0xFF at cap 1024 wrote 1536.
    writeFileSync(p, Buffer.alloc(5000, 0xff));
    capLogFile(p, 1024);
    assert.ok(statSync(p).size <= 1024, `file is within the cap, got ${statSync(p).size}`);
    assert.ok(statSync(p).size > 0, 'and is not empty');
  });
});

test('capLogFile leaves the file alone rather than emptying it at a tiny cap', () => {
  withDir((dir) => {
    const p = join(dir, 'watch.log');
    const original = 'hello world this is a log\n';
    // keep = floor(maxBytes / 2) reaches 0 at maxBytes <= 1, and a zero-byte
    // read writes an empty file: the cap would delete the log, not bound it.
    for (const maxBytes of [0, 1]) {
      writeFileSync(p, original);
      capLogFile(p, maxBytes);
      assert.equal(readFileSync(p, 'utf-8'), original, `maxBytes=${maxBytes} left the log intact`);
    }
  });
});
