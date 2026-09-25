import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { readCount, claimFetch } from '../../plugin/scripts/lib/fetch-budget.mjs';

const MODULE_URL = new URL('../../plugin/scripts/lib/fetch-budget.mjs', import.meta.url).href;
let tmpPd;

before(() => {
  tmpPd = mkdtempSync(join(tmpdir(), 'fetch-budget-test-'));
});

after(() => {
  rmSync(tmpPd, { recursive: true, force: true });
});

function claimInChild(sid, pd, budget) {
  const code =
    'import(process.argv[1]).then((m) => process.stdout.write(String(m.claimFetch(process.argv[2], process.argv[3], Number(process.argv[4])))))';
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code, MODULE_URL, sid, pd, String(budget)]);
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('exit', (status) =>
      status === 0 ? resolve(out === 'true') : reject(new Error(`child exited ${status}`)),
    );
  });
}

describe('fetch-budget claimFetch/readCount', () => {
  it('starts at 0 when nothing has been claimed', () => {
    assert.equal(readCount('fresh', tmpPd), 0);
  });

  it('grants exactly budget claims, and a refusal consumes nothing', () => {
    const sid = 'sequential';
    const results = Array.from({ length: 5 }, () => claimFetch(sid, tmpPd, 3));
    assert.deepEqual(results, [true, true, true, false, false]);
    assert.equal(readCount(sid, tmpPd), 3);
  });

  it('isolates budgets per session', () => {
    assert.equal(claimFetch('one', tmpPd, 1), true);
    assert.equal(claimFetch('one', tmpPd, 1), false);
    assert.equal(claimFetch('two', tmpPd, 1), true);
  });

  it('grants exactly budget claims when 15 processes claim a budget of 10 at once', async () => {
    const sid = 'concurrent';
    const granted = await Promise.all(
      Array.from({ length: 15 }, () => claimInChild(sid, tmpPd, 10)),
    );
    assert.equal(granted.filter(Boolean).length, 10);
    assert.equal(readCount(sid, tmpPd), 10);
  });
});
