import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { acquireLock, releaseLock } from '../plugin/scripts/lib/edges.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EDGES_MODULE_URL = pathToFileURL(join(HERE, '..', 'plugin/scripts/lib/edges.mjs')).href;

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

test('acquireLock excludes a second process while the first holds it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-edges-lock-xproc-'));
  try {
    const dbPath = join(dir, 'edges.db');
    writeFileSync(dbPath, '');

    const got = acquireLock(dbPath);
    assert.equal(got, true, 'parent acquired');

    const child = spawnSync(
      process.execPath,
      [
        '-e',
        `import(${JSON.stringify(EDGES_MODULE_URL)})` +
          `.then(({ acquireLock }) => process.exit(acquireLock(${JSON.stringify(dbPath)}) ? 0 : 1));`,
      ],
      { encoding: 'utf8', timeout: 5000 },
    );
    assert.equal(
      child.status,
      1,
      `child should fail to acquire while parent holds (stderr: ${child.stderr})`,
    );

    releaseLock(dbPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
