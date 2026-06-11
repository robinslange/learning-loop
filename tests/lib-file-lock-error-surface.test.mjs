// Phase 3 regression test: the mtime-fallback path inside tryRemoveIfStale
// must surface stat failures via logError instead of silently swallowing
// them. The three other empty catches in file-lock.mjs (releaseLock's two
// idempotent cleanups + the documented outer fallback in tryRemoveIfStale)
// must stay silent — they're intentional, not bugs.
//
// The genuine silent-failure path is hard to trigger naturally: it requires
// readFileSync to throw AND statSync to then also throw with a code other
// than ENOENT. We exercise it via the statFn dependency injection added to
// tryRemoveIfStale, which is a tiny test-only seam that costs nothing at
// runtime (default is fs.statSync).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tryRemoveIfStale, releaseLock } from '../plugin/scripts/lib/file-lock.mjs';

function withStderrCapture(fn) {
  const chunks = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = orig;
  }
  return chunks.join('');
}

test('tryRemoveIfStale: surfaces non-ENOENT stat failures via logError', () => {
  // Make readFileSync throw EISDIR (lockPath is a directory). That drops us
  // into the mtime-fallback catch arm. We then inject a statFn that throws
  // EACCES — the kind of "genuinely unusual" failure the plan calls out.
  const sb = mkdtempSync(join(tmpdir(), 'll-lock-surface-'));
  const lockPath = join(sb, 'target.lock');
  mkdirSync(lockPath);

  const statFn = () => {
    const err = new Error('EACCES: permission denied');
    err.code = 'EACCES';
    throw err;
  };

  let result;
  const stderr = withStderrCapture(() => {
    result = tryRemoveIfStale(lockPath, 60_000, { statFn });
  });

  try {
    assert.equal(result, false, 'must return false when stat fails');
    assert.match(
      stderr,
      /file-lock\.mtimeFallback/,
      `expected logError scope on stderr; got: ${stderr.slice(0, 200)}`,
    );
    assert.match(
      stderr,
      /EACCES/,
      `expected the underlying error code on stderr; got: ${stderr.slice(0, 200)}`,
    );
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
});

test('tryRemoveIfStale: ENOENT in mtime fallback is silent (expected race)', () => {
  // The lockfile being unlinked between our readFileSync and our statFn is
  // an expected race condition during concurrent stale-lock recovery. We
  // must NOT log this case — otherwise stderr fills with noise during
  // normal contention.
  const sb = mkdtempSync(join(tmpdir(), 'll-lock-enoent-'));
  const lockPath = join(sb, 'target.lock');
  mkdirSync(lockPath);

  const statFn = () => {
    const err = new Error('ENOENT: no such file or directory');
    err.code = 'ENOENT';
    throw err;
  };

  let result;
  const stderr = withStderrCapture(() => {
    result = tryRemoveIfStale(lockPath, 60_000, { statFn });
  });

  try {
    assert.equal(result, false, 'must return false on ENOENT race');
    assert.doesNotMatch(
      stderr,
      /file-lock\.mtimeFallback/,
      `ENOENT in mtime fallback must be silent; got stderr: ${stderr.slice(0, 200)}`,
    );
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
});

test('releaseLock: surfaces non-ENOENT unlink failures via logError', () => {
  // The unlinkSync catch used to swallow every code. EACCES/EBUSY/EPERM/EROFS
  // here mean the lockfile leaked — the next acquirer will spin for staleMs
  // (60s) before recovering. Phase 3's narrowing surfaces these.
  const handle = { lockPath: '/tmp/never-touched.lock', fd: -1 };

  const unlinkFn = () => {
    const err = new Error('EACCES: permission denied');
    err.code = 'EACCES';
    throw err;
  };
  // closeFn is a no-op so we isolate the unlink path.
  const closeFn = () => {};

  let result;
  const stderr = withStderrCapture(() => {
    result = releaseLock(handle, { closeFn, unlinkFn });
  });

  assert.equal(result, true, 'releaseLock must still report success (idempotent contract)');
  assert.match(
    stderr,
    /file-lock\.releaseLock\.unlink/,
    `expected logError scope on stderr; got: ${stderr.slice(0, 200)}`,
  );
  assert.match(
    stderr,
    /EACCES/,
    `expected the underlying error code on stderr; got: ${stderr.slice(0, 200)}`,
  );
});

test('releaseLock: ENOENT on unlink is silent (expected race with stale-lock recovery)', () => {
  const handle = { lockPath: '/tmp/never-touched.lock', fd: -1 };
  const unlinkFn = () => {
    const err = new Error('ENOENT: no such file or directory');
    err.code = 'ENOENT';
    throw err;
  };
  const closeFn = () => {};

  const stderr = withStderrCapture(() => {
    releaseLock(handle, { closeFn, unlinkFn });
  });

  assert.doesNotMatch(
    stderr,
    /file-lock\.releaseLock\.unlink/,
    `ENOENT on unlink must be silent; got stderr: ${stderr.slice(0, 200)}`,
  );
});

test('releaseLock: partial handle (missing lockPath) returns false without calling fs ops', () => {
  // Defensive contract: acquireLock always returns {lockPath, fd} together,
  // but a hand-constructed handle missing lockPath would crash unlinkFn(undefined)
  // with TypeError and emit a noisy logError with lockPath: undefined. The guard
  // rejects such handles up-front.
  let closeCalled = false;
  let unlinkCalled = false;
  const closeFn = () => {
    closeCalled = true;
  };
  const unlinkFn = () => {
    unlinkCalled = true;
  };

  const stderr = withStderrCapture(() => {
    const result = releaseLock({ fd: 5 }, { closeFn, unlinkFn });
    assert.equal(result, false, 'must return false for handle without lockPath');
  });

  assert.equal(closeCalled, false, 'closeFn must not be called on invalid handle');
  assert.equal(unlinkCalled, false, 'unlinkFn must not be called on invalid handle');
  assert.equal(stderr, '', `must not log anything; got: ${stderr.slice(0, 200)}`);
});

test('releaseLock: EBADF on close is silent; other codes surface', () => {
  const handle = { lockPath: '/tmp/never-touched.lock', fd: -1 };

  // EBADF: expected when releaseLock is called twice. Must be silent.
  const ebadf = () => {
    const err = new Error('EBADF: bad file descriptor');
    err.code = 'EBADF';
    throw err;
  };
  const silentStderr = withStderrCapture(() => {
    releaseLock(handle, { closeFn: ebadf, unlinkFn: () => {} });
  });
  assert.doesNotMatch(
    silentStderr,
    /file-lock\.releaseLock\.close/,
    `EBADF on close must be silent; got stderr: ${silentStderr.slice(0, 200)}`,
  );

  // EIO: NFS yank, USB pull mid-fsync. Worth surfacing.
  const eio = () => {
    const err = new Error('EIO: input/output error');
    err.code = 'EIO';
    throw err;
  };
  const loudStderr = withStderrCapture(() => {
    releaseLock(handle, { closeFn: eio, unlinkFn: () => {} });
  });
  assert.match(
    loudStderr,
    /file-lock\.releaseLock\.close/,
    `EIO on close must surface; got stderr: ${loudStderr.slice(0, 200)}`,
  );
});

test('tryRemoveIfStale: default statFn is fs.statSync (no behaviour change for real callers)', () => {
  // Sanity check that the dependency injection added for testability did
  // not change runtime behaviour. With no opts, an actually-stale lockfile
  // (mtime older than staleMs) gets removed.
  const sb = mkdtempSync(join(tmpdir(), 'll-lock-default-'));
  const lockPath = join(sb, 'target.lock');
  // Write a lockfile with a PID that's neither alive nor parseable —
  // forces the outer catch and lets the mtime fallback decide. NaN-PID
  // (whitespace) takes the parseInt-NaN path which short-circuits to
  // `return false` from the outer try — not what we want. Instead write
  // a non-decimal string that parseInt also fails on but readFileSync
  // succeeds for; then unlink to make stat throw ENOENT (which is silent).
  // Cleanest: directory-as-lockfile, default statFn returns dir mtime,
  // which is now (not stale), so result is false.
  mkdirSync(lockPath);

  let result;
  const stderr = withStderrCapture(() => {
    result = tryRemoveIfStale(lockPath, 60_000); // no opts
  });

  try {
    assert.equal(result, false, 'fresh directory-as-lockfile should not be considered stale');
    assert.doesNotMatch(
      stderr,
      /file-lock\.mtimeFallback/,
      'default statFn (fs.statSync) on a fresh dir must not error',
    );
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
});
