import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const RFC_RESPONSE = {
  title: 'Hypertext Transfer Protocol',
  authors: [{ name: 'Roy Fielding' }, { name: 'Jim Gettys' }],
  pub_date: 'June 1999',
  pub_status: 'DRAFT STANDARD',
  abstract: 'The Hypertext Transfer Protocol (HTTP) is an application-level protocol.',
};

describe('rfc adapter', () => {
  let originalFetch;
  let adapter;

  before(async () => {
    originalFetch = globalThis.fetch;
    adapter = (await import('../../scripts/lib/sources/adapters/rfc.mjs')).default;
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  it('fetchById returns metadata on success', async () => {
    globalThis.fetch = async () => ({ ok: true, json: async () => RFC_RESPONSE });
    const data = await adapter.fetchById('2616');
    assert.equal(data.source, 'rfc');
    assert.equal(data.rfcNumber, 2616);
    assert.equal(data.title, 'Hypertext Transfer Protocol');
    assert.ok(data.authors.includes('Roy Fielding'));
    assert.equal(data.year, 1999);
    assert.equal(data.studyType, 'standard');
    assert.equal(data.journal, 'IETF RFC');
  });

  it('fetchById returns null on 404', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 404 });
    const data = await adapter.fetchById('99999');
    assert.equal(data, null);
  });

  it('verify returns verified:true on success', async () => {
    globalThis.fetch = async () => ({ ok: true, json: async () => RFC_RESPONSE });
    const result = await adapter.verify({ rfcNumber: '2616' });
    assert.equal(result.verified, true);
    assert.deepEqual(result.issues, []);
  });

  it('verify returns error on 404', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 404 });
    const result = await adapter.verify({ rfcNumber: '99999' });
    assert.equal(result.verified, false);
    assert.ok(result.error);
    assert.equal(result.metadata, null);
  });
});
