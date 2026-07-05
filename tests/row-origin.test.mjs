import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveOrigin,
  flattenRows,
  stripPointerContent,
} from '../plugin/scripts/lib/row-origin.mjs';

describe('deriveOrigin', () => {
  it('derives peer + peer id from a peer: path', () => {
    assert.deepEqual(deriveOrigin({ path: 'peer:thomas_kirk/note.md' }), {
      origin: 'peer',
      sourceId: 'thomas_kirk',
    });
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

describe('stripPointerContent', () => {
  it('strips content and text from a peer row', () => {
    const row = {
      path: 'peer:thomas/b.md',
      score: 0.8,
      title: 'B',
      content: 'SECRET',
      text: 'more',
    };
    const stripped = stripPointerContent(row);
    assert.equal('content' in stripped, false);
    assert.equal('text' in stripped, false);
    assert.equal(stripped.path, 'peer:thomas/b.md');
    assert.equal(stripped.title, 'B');
    assert.equal(stripped.score, 0.8);
  });
  it('drops an UNKNOWN body-bearing field (allowlist, not denylist)', () => {
    const row = { path: 'peer:thomas/b.md', score: 0.8, snippet: 'LEAK', excerpt: 'also leak' };
    const stripped = stripPointerContent(row);
    assert.equal('snippet' in stripped, false);
    assert.equal('excerpt' in stripped, false);
    assert.equal(stripped.path, 'peer:thomas/b.md');
    assert.equal(stripped.score, 0.8);
  });
  it('keeps mtime and index (real binary pointer fields)', () => {
    const row = { path: 'peer:x/b.md', score: 0.8, title: 'B', mtime: 123, index: 2, body: 'drop' };
    const stripped = stripPointerContent(row);
    assert.equal(stripped.mtime, 123);
    assert.equal(stripped.index, 2);
    assert.equal('body' in stripped, false);
  });
  it('keeps tags (real SimilarResult pointer field) as a verbatim no-op', () => {
    const row = { path: 'peer:x/b.md', score: 0.8, tags: 'a,b' };
    assert.strictEqual(stripPointerContent(row), row);
  });
  it('keeps note/id locator keys deriveOrigin trusts', () => {
    const row = { note: 'peer:p/x', score: 0.5, content: 'drop' };
    const stripped = stripPointerContent(row);
    assert.equal(stripped.note, 'peer:p/x');
    assert.equal('content' in stripped, false);
  });
  it('returns a local row with content unchanged (same reference)', () => {
    const row = { path: 'local.md', score: 0.9, content: 'local body stays' };
    assert.strictEqual(stripPointerContent(row), row);
  });
  it('returns a pointer-only peer row as same reference (verbatim no-op)', () => {
    const row = { path: 'peer:x/b.md', score: 0.8, title: 'B', mtime: 5 };
    assert.strictEqual(stripPointerContent(row), row);
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
