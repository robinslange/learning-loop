import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import {
  acquireLock,
  releaseLock,
  withLock,
  tryRemoveIfStale,
} from '../plugin/scripts/lib/file-lock.mjs';

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'll-flock-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('acquire then release leaves no lockfile', () => {
  withTempDir((dir) => {
    const target = join(dir, 'edges.db');
    const h = acquireLock(target);
    assert.ok(h, 'expected handle');
    assert.equal(existsSync(target + '.lock'), true);
    releaseLock(h);
    assert.equal(existsSync(target + '.lock'), false);
  });
});

test('lockfile contains the current PID', () => {
  withTempDir((dir) => {
    const target = join(dir, 'pid.json');
    const h = acquireLock(target);
    assert.ok(h);
    const pid = parseInt(readFileSync(target + '.lock', 'utf8').trim(), 10);
    assert.equal(pid, process.pid);
    releaseLock(h);
  });
});

test('second acquire while held returns null after retries', () => {
  withTempDir((dir) => {
    const target = join(dir, 'a.json');
    const first = acquireLock(target);
    assert.ok(first);
    const second = acquireLock(target, { retries: 2, retryDelayMs: 5 });
    assert.equal(second, null);
    releaseLock(first);
  });
});

test('stale lock with dead PID is reclaimed', () => {
  withTempDir((dir) => {
    const target = join(dir, 'stale.json');
    // Write a lockfile with an impossibly high PID (very unlikely to be alive).
    writeFileSync(target + '.lock', '99999999');
    const h = acquireLock(target, { retries: 2, retryDelayMs: 5 });
    assert.ok(h, 'expected stale lock to be reclaimed');
    releaseLock(h);
  });
});

test('stale-by-mtime fallback: alive PID prevents reclaim', () => {
  withTempDir((dir) => {
    const target = join(dir, 'old.json');
    // Lock owned by our own PID — definitely alive.
    writeFileSync(target + '.lock', String(process.pid));
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(target + '.lock', old, old);
    // With an alive PID, tryRemoveIfStale returns false; all retries fail.
    const h = acquireLock(target, { retries: 2, retryDelayMs: 5, staleMs: 60_000 });
    assert.equal(h, null, 'alive-PID lock must not be stolen');
    // After manual removal, a fresh acquire succeeds.
    rmSync(target + '.lock');
    const h2 = acquireLock(target);
    assert.ok(h2);
    releaseLock(h2);
  });
});

test('withLock runs fn under lock and releases on success', () => {
  withTempDir((dir) => {
    const target = join(dir, 'wl.json');
    const result = withLock(target, {}, () => {
      assert.equal(existsSync(target + '.lock'), true);
      return 42;
    });
    assert.equal(result, 42);
    assert.equal(existsSync(target + '.lock'), false);
  });
});

test('withLock releases lock when fn throws', () => {
  withTempDir((dir) => {
    const target = join(dir, 'wl-throw.json');
    assert.throws(
      () =>
        withLock(target, {}, () => {
          throw new Error('boom');
        }),
      /boom/,
    );
    assert.equal(existsSync(target + '.lock'), false);
  });
});

test('withLock throws ELOCK_TIMEOUT when lock unavailable', () => {
  withTempDir((dir) => {
    const target = join(dir, 'wl-timeout.json');
    const first = acquireLock(target);
    assert.ok(first);
    try {
      withLock(target, { retries: 1, retryDelayMs: 5 }, () => {});
      assert.fail('expected ELOCK_TIMEOUT');
    } catch (e) {
      assert.equal(e.code, 'ELOCK_TIMEOUT');
    } finally {
      releaseLock(first);
    }
  });
});

test('releaseLock is idempotent on null/undefined handle', () => {
  assert.equal(releaseLock(null), false);
  assert.equal(releaseLock(undefined), false);
  assert.equal(releaseLock({}), false);
});

// #2: an empty/garbage lockfile parses to NaN, so the PID branch can't remove
// it. The mtime staleness backstop must still apply, or the lock wedges forever.
test('empty stale lockfile is reclaimed via mtime staleness', () => {
  withTempDir((dir) => {
    const target = join(dir, 'empty.json');
    writeFileSync(target + '.lock', ''); // 0 bytes: parseInt('') === NaN
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(target + '.lock', old, old);
    const removed = tryRemoveIfStale(target + '.lock', 60_000);
    assert.equal(removed, true, 'old empty lockfile must be reclaimed by mtime');
    assert.equal(existsSync(target + '.lock'), false);
  });
});

test('garbage (non-numeric) fresh lockfile is NOT reclaimed by mtime', () => {
  withTempDir((dir) => {
    const target = join(dir, 'garbage.json');
    writeFileSync(target + '.lock', 'not-a-pid'); // parseInt -> NaN, but fresh
    const removed = tryRemoveIfStale(target + '.lock', 60_000);
    assert.equal(removed, false, 'a fresh unreadable lock is not yet stale');
    assert.equal(existsSync(target + '.lock'), true);
  });
});

test('acquireLock recovers an empty stale lock (full path, not just tryRemoveIfStale)', () => {
  withTempDir((dir) => {
    const target = join(dir, 'acq-empty.json');
    writeFileSync(target + '.lock', '');
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(target + '.lock', old, old);
    const h = acquireLock(target, { retries: 2, retryDelayMs: 5, staleMs: 60_000 });
    assert.ok(h, 'empty stale lock must be reclaimable by acquireLock');
    releaseLock(h);
  });
});

// #5: a stale lock that only becomes removable on the FINAL retry iteration
// must still be re-acquired, not fall through to null.
test('stale lock cleared on the final retry is still acquired (retries:1)', () => {
  withTempDir((dir) => {
    const target = join(dir, 'final.json');
    writeFileSync(target + '.lock', '99999999'); // dead PID
    const h = acquireLock(target, { retries: 1, retryDelayMs: 5 });
    assert.ok(h, 'retries:1 must reclaim a dead-PID stale lock on the first (final) pass');
    releaseLock(h);
  });
});

// Boundary: the mtime staleness threshold is strict (>), so a lock aged
// exactly staleMs is NOT yet stale; one ms older is.
test('mtime staleness boundary is strict (age == staleMs is not stale)', () => {
  withTempDir((dir) => {
    const target = join(dir, 'boundary.json');
    writeFileSync(target + '.lock', ''); // empty -> mtime path
    const now = Date.now();
    // statFn injected so the age is exact, independent of filesystem clock.
    const atThreshold = tryRemoveIfStale(target + '.lock', 1000, {
      statFn: () => ({ mtimeMs: now - 1000 }),
    });
    assert.equal(atThreshold, false, 'age exactly staleMs must not be reclaimed');
    assert.equal(existsSync(target + '.lock'), true);

    const pastThreshold = tryRemoveIfStale(target + '.lock', 1000, {
      statFn: () => ({ mtimeMs: now - 1001 }),
    });
    assert.equal(pastThreshold, true, 'age staleMs+1 must be reclaimed');
    assert.equal(existsSync(target + '.lock'), false);
  });
});

// A non-positive PID must route to the mtime backstop, not be handed to the
// liveness probe as if it were a real process id.
test('non-positive PID uses the mtime backstop (fresh => not removed)', () => {
  withTempDir((dir) => {
    const target = join(dir, 'zeropid.json');
    writeFileSync(target + '.lock', '0'); // pid 0 is not a valid owner
    const removed = tryRemoveIfStale(target + '.lock', 60_000, {
      statFn: () => ({ mtimeMs: Date.now() }), // fresh
    });
    assert.equal(removed, false, 'fresh pid-0 lock is not reclaimed');
    assert.equal(existsSync(target + '.lock'), true);
  });
});

// #5 precision: the stale lock is re-acquired within a SINGLE retry iteration,
// so retries:1 suffices and the inner re-open runs exactly once.
test('final-iteration re-open acquires without consuming a second retry', () => {
  withTempDir((dir) => {
    const target = join(dir, 'reopen.json');
    writeFileSync(target + '.lock', '99999999'); // dead pid, removable immediately
    // retries:1 means the ONLY chance is the in-iteration re-open.
    const h = acquireLock(target, { retries: 1, retryDelayMs: 5 });
    assert.ok(h, 'in-iteration re-open must acquire on the single retry');
    // The lock we now hold is our own.
    assert.equal(readFileSync(target + '.lock', 'utf8').trim(), String(process.pid));
    releaseLock(h);
  });
});

// #7: a PID-write failure must not leak the fd or orphan an empty lockfile.
test('write failure after open cleans up the lockfile (no orphan)', () => {
  withTempDir((dir) => {
    const target = join(dir, 'wfail.json');
    const boom = () => {
      const e = new Error('disk full');
      e.code = 'ENOSPC';
      throw e;
    };
    assert.throws(
      () => acquireLock(target, { retries: 1, writeFn: boom }),
      /disk full/,
      'the write error propagates',
    );
    assert.equal(existsSync(target + '.lock'), false, 'no empty lockfile left behind');
  });
});

test('cross-process race: both children terminate cleanly (mutual exclusion holds)', async () => {
  const flockUrl = new URL('../plugin/scripts/lib/file-lock.mjs', import.meta.url).href;
  const dir = mkdtempSync(join(tmpdir(), 'll-flock-race-'));
  try {
    const target = join(dir, 'race.json');
    const code = `
import { acquireLock, releaseLock } from ${JSON.stringify(flockUrl)};
const h = acquireLock(${JSON.stringify(target)}, { retries: 2, retryDelayMs: 10 });
if (h) {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, 50);
  releaseLock(h);
  process.exit(0);
} else {
  process.exit(7);
}
`;
    const spawnChild = () =>
      new Promise((r) => {
        const c = spawn(process.execPath, ['--input-type=module'], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        c.stdin.end(code);
        c.on('close', (exitCode) => r(exitCode));
      });

    const [a, b] = await Promise.all([spawnChild(), spawnChild()]);
    const winners = [a, b].filter((c) => c === 0).length;
    const losers = [a, b].filter((c) => c === 7).length;
    // At least one must have won; combined they must account for both outcomes.
    assert.equal(winners + losers, 2, `unexpected exit codes: ${a}, ${b}`);
    assert.ok(winners >= 1, 'at least one child must acquire the lock');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
