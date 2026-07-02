import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readCount, bumpCount } from '../../plugin/scripts/lib/fetch-budget.mjs';

const sessionId = 'test-session-abc';
let tmpPd;

before(() => {
  tmpPd = join(tmpdir(), `fetch-budget-test-${Date.now()}`);
  mkdirSync(tmpPd, { recursive: true });
});

after(() => {
  rmSync(tmpPd, { recursive: true, force: true });
});

describe('fetch-budget readCount/bumpCount', () => {
  it('starts at 0 when no file exists', () => {
    assert.equal(readCount(sessionId, tmpPd), 0);
  });

  it('bump increments across calls (models cross-process persistence)', () => {
    bumpCount(sessionId, tmpPd);
    assert.equal(readCount(sessionId, tmpPd), 1);
    bumpCount(sessionId, tmpPd);
    assert.equal(readCount(sessionId, tmpPd), 2);
  });

  it('isolates counters per sessionId', () => {
    const other = 'other-session-xyz';
    assert.equal(readCount(other, tmpPd), 0);
    bumpCount(other, tmpPd);
    assert.equal(readCount(other, tmpPd), 1);
    assert.equal(readCount(sessionId, tmpPd), 2); // unchanged
  });

  it('gracefully returns 0 when pluginData is null', () => {
    assert.equal(readCount(sessionId, null), 0);
  });

  it('gracefully no-ops bump when pluginData is null', () => {
    assert.doesNotThrow(() => bumpCount(sessionId, null));
  });

  it('gracefully returns 0 when sessionId is empty', () => {
    assert.equal(readCount('', tmpPd), 0);
  });

  it('gracefully no-ops bump when sessionId is empty', () => {
    assert.doesNotThrow(() => bumpCount('', tmpPd));
  });

  it('gracefully returns 0 when sessionId is "unknown"', () => {
    assert.equal(readCount('unknown', tmpPd), 0);
  });

  it('gracefully no-ops bump when sessionId is "unknown"', () => {
    assert.doesNotThrow(() => bumpCount('unknown', tmpPd));
  });
});
