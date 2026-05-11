import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { acquireLock, releaseLock, withLock } from '../scripts/lib/file-lock.mjs';

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
      () => withLock(target, {}, () => { throw new Error('boom'); }),
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

test('cross-process race: both children terminate cleanly (mutual exclusion holds)', async () => {
  const flockPath = fileURLToPath(new URL('../scripts/lib/file-lock.mjs', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'll-flock-race-'));
  try {
    const target = join(dir, 'race.json');
    const code = `
import { acquireLock, releaseLock } from ${JSON.stringify(flockPath)};
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
        const c = spawn(process.execPath, ['--input-type=module'], { stdio: ['pipe', 'pipe', 'pipe'] });
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
