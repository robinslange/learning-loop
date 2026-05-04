import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, releaseLock } from '../scripts/lib/edges.mjs';

test('acquireLock + releaseLock create and clean up the lock file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-edges-lock-'));
  try {
    const dbPath = join(dir, 'edges.db');
    writeFileSync(dbPath, '');

    const got = acquireLock(dbPath);
    assert.equal(got, true, 'first acquire should succeed');
    assert.equal(existsSync(dbPath + '.lock'), true, 'lock file present');

    const second = acquireLock(dbPath);
    assert.equal(second, false, 'second acquire from same process returns false');

    releaseLock(dbPath);
    assert.equal(existsSync(dbPath + '.lock'), false, 'lock file removed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
