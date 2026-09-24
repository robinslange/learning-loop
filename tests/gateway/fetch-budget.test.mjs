import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { readCount, tryBump, budgetScopeSegment } from '../../plugin/scripts/lib/fetch-budget.mjs';

const sessionId = 'test-session-abc';
let tmpPd;

before(() => {
  tmpPd = join(tmpdir(), `fetch-budget-test-${Date.now()}`);
  mkdirSync(tmpPd, { recursive: true });
});

after(() => {
  rmSync(tmpPd, { recursive: true, force: true });
});

describe('fetch-budget readCount', () => {
  it('starts at 0 when no file exists', () => {
    assert.equal(readCount(sessionId, tmpPd), 0);
  });

  it('isolates counters per sessionId', () => {
    const a = `iso-a-${Date.now()}`,
      b = `iso-b-${Date.now()}`;
    tryBump(a, tmpPd, 10);
    tryBump(a, tmpPd, 10);
    tryBump(b, tmpPd, 10);
    assert.equal(readCount(a, tmpPd), 2);
    assert.equal(readCount(b, tmpPd), 1);
  });

  it('gracefully returns 0 when pluginData is null', () => {
    assert.equal(readCount(sessionId, null), 0);
  });

  it('gracefully returns 0 when sessionId is empty', () => {
    assert.equal(readCount('', tmpPd), 0);
  });

  it('gracefully returns 0 when sessionId is "unknown"', () => {
    assert.equal(readCount('unknown', tmpPd), 0);
  });
});

describe('tryBump', () => {
  it('lets exactly budget of N concurrent processes through', async () => {
    const sid = `race-${Date.now()}`;
    const mod = new URL('../../plugin/scripts/lib/fetch-budget.mjs', import.meta.url).href;
    const script = `import { tryBump } from ${JSON.stringify(mod)}; process.stdout.write(tryBump(${JSON.stringify(sid)}, ${JSON.stringify(tmpPd)}, 10) ? '1' : '0');`;
    const outs = await Promise.all(
      Array.from(
        { length: 30 },
        () =>
          new Promise((resolve) => {
            const p = spawn(process.execPath, ['--input-type=module', '-e', script]);
            let s = '';
            p.stdout.on('data', (d) => (s += d));
            p.on('close', () => resolve(s));
          }),
      ),
    );
    assert.equal(outs.filter((o) => o === '1').length, 10);
  });
  it('degrades to allowing when pluginData or sessionId is unusable', () => {
    assert.equal(tryBump('s', null, 0), true);
    assert.equal(tryBump('unknown', tmpPd, 0), true);
    assert.equal(tryBump('s', '/proc/definitely/not/writable', 0), true);
  });
});

describe('budgetScopeSegment', () => {
  it('maps session ids onto the scope grammar', () => {
    assert.equal(budgetScopeSegment('3F2A-99bc_X'), '3f2a-99bc_x');
    assert.equal(budgetScopeSegment('a b/c'), 'a-b-c');
    assert.equal(budgetScopeSegment('unknown'), null);
    assert.equal(budgetScopeSegment(''), null);
    assert.equal(budgetScopeSegment('...'), null);
  });
});
