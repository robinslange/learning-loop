import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { readCount, bumpCount } from '../../plugin/scripts/lib/fetch-budget.mjs';

const MODULE_URL = new URL('../../plugin/scripts/lib/fetch-budget.mjs', import.meta.url).href;
const sessionId = 'test-session-abc';
let tmpPd;

before(() => {
  tmpPd = mkdtempSync(join(tmpdir(), 'fetch-budget-test-'));
});

after(() => {
  rmSync(tmpPd, { recursive: true, force: true });
});

function bumpInChild(sid, pd) {
  const code = 'import(process.argv[1]).then((m) => m.bumpCount(process.argv[2], process.argv[3]))';
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code, MODULE_URL, sid, pd], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (status) =>
      status === 0 ? resolve() : reject(new Error(`child exited ${status}`)),
    );
  });
}

describe('fetch-budget readCount/bumpCount', () => {
  it('starts at 0 when no file exists', () => {
    assert.equal(readCount(sessionId, tmpPd), 0);
  });

  it('bump returns the new count and persists it', () => {
    assert.equal(bumpCount(sessionId, tmpPd), 1);
    assert.equal(readCount(sessionId, tmpPd), 1);
    assert.equal(bumpCount(sessionId, tmpPd), 2);
    assert.equal(readCount(sessionId, tmpPd), 2);
  });

  it('isolates counters per sessionId', () => {
    const other = 'other-session-xyz';
    assert.equal(readCount(other, tmpPd), 0);
    bumpCount(other, tmpPd);
    assert.equal(readCount(other, tmpPd), 1);
    assert.equal(readCount(sessionId, tmpPd), 2);
  });

  it('loses no bumps when 20 processes bump the same session at once', async () => {
    const sid = 'concurrent-session';
    await Promise.all(Array.from({ length: 20 }, () => bumpInChild(sid, tmpPd)));
    assert.equal(readCount(sid, tmpPd), 20);
  });
});
