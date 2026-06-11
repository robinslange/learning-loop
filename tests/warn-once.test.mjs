import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { warnOnce, resetForTests } from '../plugin/scripts/lib/warn-once.mjs';

describe('warnOnce', () => {
  beforeEach(() => {
    resetForTests('test-key');
    resetForTests('other');
  });

  it('writes the message exactly once per key', () => {
    const writes = [];
    const orig = process.stderr.write;
    process.stderr.write = (s) => {
      writes.push(s);
      return true;
    };
    try {
      warnOnce('test-key', 'hello\n');
      warnOnce('test-key', 'hello\n');
      warnOnce('test-key', 'hello\n');
    } finally {
      process.stderr.write = orig;
    }
    assert.deepEqual(writes, ['hello\n']);
  });

  it('treats different keys independently', () => {
    const writes = [];
    const orig = process.stderr.write;
    process.stderr.write = (s) => {
      writes.push(s);
      return true;
    };
    try {
      warnOnce('test-key', 'A\n');
      warnOnce('other', 'B\n');
    } finally {
      process.stderr.write = orig;
    }
    assert.deepEqual(writes, ['A\n', 'B\n']);
  });
});
