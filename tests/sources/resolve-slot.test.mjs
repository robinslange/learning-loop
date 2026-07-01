import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSlot } from '../../plugin/scripts/lib/sources/registry.mjs';

const cfg = (over) => ({ web_search: 'brave', fetch: 'raw', research: 'librarian', providers: {}, ...over });

describe('resolveSlot', () => {
  it('resolves web_search default to the brave source', () => {
    const s = resolveSlot('web_search', { cfg: cfg() });
    assert.equal(s.id, 'brave');
    assert.ok(s.capabilities.includes('query'));
  });
  it('resolves fetch default to the raw source', () => {
    assert.equal(resolveSlot('fetch', { cfg: cfg() }).id, 'raw');
  });
  it('throws loud on an unknown configured id', () => {
    assert.throws(() => resolveSlot('web_search', { cfg: cfg({ web_search: 'exaa' }) }), /unknown source id "exaa"/);
  });
});
