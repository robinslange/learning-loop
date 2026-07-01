// tests/secret.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSecret } from '../plugin/scripts/lib/secret.mjs';

describe('resolveSecret', () => {
  it('returns the resolved key via injected keyResolver', () => {
    const r = resolveSecret('brave-search-api-key', { keyResolver: () => '  abc123\n' });
    assert.equal(r, 'abc123');
  });
  it('returns null on a falsy ref without calling the resolver', () => {
    let called = false;
    const r = resolveSecret('', { keyResolver: () => { called = true; return 'x'; } });
    assert.equal(r, null);
    assert.equal(called, false);
  });
  it('returns null when the resolver throws', () => {
    const r = resolveSecret('missing', { keyResolver: () => { throw new Error('not found'); } });
    assert.equal(r, null);
  });
});
