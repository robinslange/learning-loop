import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getSessionId } from '../scripts/lib/session.mjs';

test('getSessionId returns ppid-suffixed when present', () => {
  const ppid = process.ppid;
  const path = join(tmpdir(), `learning-loop-session-id-${ppid}`);
  writeFileSync(path, 'session-from-ppid');
  try {
    assert.equal(getSessionId(), 'session-from-ppid');
  } finally {
    rmSync(path, { force: true });
  }
});

test('getSessionId falls back to unsuffixed when ppid-suffixed absent', () => {
  const ppid = process.ppid;
  const suffixed = join(tmpdir(), `learning-loop-session-id-${ppid}`);
  rmSync(suffixed, { force: true });
  const fallback = join(tmpdir(), 'learning-loop-session-id');
  writeFileSync(fallback, 'session-unsuffixed');
  try {
    assert.equal(getSessionId(), 'session-unsuffixed');
  } finally {
    rmSync(fallback, { force: true });
  }
});

test('getSessionId returns "unknown" when both files absent', () => {
  const ppid = process.ppid;
  rmSync(join(tmpdir(), `learning-loop-session-id-${ppid}`), { force: true });
  rmSync(join(tmpdir(), 'learning-loop-session-id'), { force: true });
  assert.equal(getSessionId(), 'unknown');
});

test('getSessionId trims trailing whitespace from file contents', () => {
  const ppid = process.ppid;
  const path = join(tmpdir(), `learning-loop-session-id-${ppid}`);
  writeFileSync(path, 'session-with-newline\n');
  try {
    assert.equal(getSessionId(), 'session-with-newline');
  } finally {
    rmSync(path, { force: true });
  }
});
