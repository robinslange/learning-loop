import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const CR_RESPONSE = {
  message: {
    DOI: '10.1234/test',
    title: ['Test Paper Title'],
    author: [
      { family: 'Smith', given: 'Alice' },
      { family: 'Jones', given: 'Bob' },
    ],
    'published-print': { 'date-parts': [[2020]] },
    'container-title': ['Journal of Testing'],
    abstract: '<p>Abstract text with 42% improvement</p>',
    type: 'journal-article',
  },
};

const BIORXIV_RESPONSE = {
  collection: [
    {
      doi: '10.1101/2020.01.01.000001',
      title: 'BioRxiv Preprint',
      authors: 'Brown Alice; Wilson Bob',
      date: '2020-01-15',
      server: 'biorxiv',
      abstract: 'A preprint abstract.',
    },
  ],
};

describe('crossref adapter', () => {
  let originalFetch;
  let adapter;

  before(async () => {
    originalFetch = globalThis.fetch;
    adapter = (await import('../../plugin/scripts/lib/sources/adapters/crossref.mjs')).default;
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  it('verify returns verified:true for correct first author', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => CR_RESPONSE,
    });
    const result = await adapter.verify({
      doi: '10.1234/test',
      claimedAuthor: 'Smith',
      claimedYear: 2020,
    });
    assert.equal(result.verified, true);
    assert.equal(result.metadata.source, 'crossref');
  });

  it('verify returns wrong_author issue', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => CR_RESPONSE,
    });
    const result = await adapter.verify({
      doi: '10.1234/test',
      claimedAuthor: 'Hinton',
      claimedYear: 2020,
    });
    assert.equal(result.verified, false);
    assert.ok(result.issues.find((i) => i.type === 'wrong_author'));
  });

  it('verify returns DOI not found on 404', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => null });
    const result = await adapter.verify({ doi: '10.9999/notfound', claimedAuthor: 'Smith' });
    assert.equal(result.verified, false);
    assert.equal(result.error, 'DOI not found');
  });

  it('verify falls back to bioRxiv for 10.1101/ DOI on 404', async () => {
    let callCount = 0;
    globalThis.fetch = async (url) => {
      callCount++;
      if (url.includes('crossref')) return { ok: false, status: 404, json: async () => null };
      return { ok: true, json: async () => BIORXIV_RESPONSE };
    };
    const result = await adapter.verify({
      doi: '10.1101/2020.01.01.000001',
      claimedAuthor: 'Brown',
    });
    assert.equal(result.verified, true);
    assert.equal(result.metadata.source, 'biorxiv');
    assert.ok(callCount >= 2);
  });
});
