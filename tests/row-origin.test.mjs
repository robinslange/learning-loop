import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deriveOrigin, flattenRows } from '../plugin/scripts/lib/row-origin.mjs';

describe('deriveOrigin', () => {
  it('derives peer + peer id from a peer: path', () => {
    assert.deepEqual(deriveOrigin({ path: 'peer:thomas_kirk/note.md' }), { origin: 'peer', sourceId: 'thomas_kirk' });
  });
  it('derives local for a plain path (and null sourceId)', () => {
    assert.deepEqual(deriveOrigin({ path: 'a.md' }), { origin: 'local', sourceId: null });
  });
  it('reads path | note | id, in that order', () => {
    assert.equal(deriveOrigin({ note: 'peer:p/x' }).origin, 'peer');
    assert.equal(deriveOrigin({ id: 'peer:p/x' }).origin, 'peer');
    assert.equal(deriveOrigin({}).origin, 'local');
    assert.equal(deriveOrigin(null).origin, 'local');
  });
});

describe('flattenRows', () => {
  it('handles a bare array', () => {
    assert.equal(flattenRows([{ path: 'a' }, { path: 'b' }]).length, 2);
  });
  it('handles { results: [...] }', () => {
    assert.equal(flattenRows({ results: [{ path: 'a' }] }).length, 1);
  });
  it('handles reflect-scan { queries: [{ results: [...] }] }', () => {
    const p = { queries: [{ results: [{ path: 'a' }] }, { results: [{ path: 'peer:p/b' }] }] };
    assert.equal(flattenRows(p).length, 2);
  });
  it('returns [] for junk', () => {
    assert.deepEqual(flattenRows(null), []);
    assert.deepEqual(flattenRows({}), []);
    assert.deepEqual(flattenRows(42), []);
  });
});
