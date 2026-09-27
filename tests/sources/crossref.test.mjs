import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { HttpResponse, countRequests, http, startMockNetwork } from '../helpers/msw.mjs';

const CROSSREF_WORK = 'https://api.crossref.org/works/*';
const BIORXIV_DETAILS = 'https://api.biorxiv.org/details/*';
const server = startMockNetwork();

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
  let adapter;

  before(async () => {
    adapter = (await import('../../plugin/scripts/lib/sources/adapters/crossref.mjs')).default;
  });

  it('verify returns verified:true for correct first author', async () => {
    server.use(http.get(CROSSREF_WORK, () => HttpResponse.json(CR_RESPONSE)));
    const result = await adapter.verify({
      doi: '10.1234/test',
      claimedAuthor: 'Smith',
      claimedYear: 2020,
    });
    assert.equal(result.verified, true);
    assert.equal(result.metadata.source, 'crossref');
  });

  it('verify returns wrong_author issue', async () => {
    server.use(http.get(CROSSREF_WORK, () => HttpResponse.json(CR_RESPONSE)));
    const result = await adapter.verify({
      doi: '10.1234/test',
      claimedAuthor: 'Hinton',
      claimedYear: 2020,
    });
    assert.equal(result.verified, false);
    assert.ok(result.issues.find((i) => i.type === 'wrong_author'));
  });

  it('verify returns DOI not found on 404', async () => {
    server.use(http.get(CROSSREF_WORK, () => new HttpResponse('', { status: 404 })));
    const result = await adapter.verify({ doi: '10.9999/notfound', claimedAuthor: 'Smith' });
    assert.equal(result.verified, false);
    assert.equal(result.error, 'DOI not found');
  });

  it('verify falls back to bioRxiv for 10.1101/ DOI on 404', async () => {
    const requests = countRequests();
    server.use(
      http.get(CROSSREF_WORK, () => new HttpResponse('', { status: 404 })),
      http.get(BIORXIV_DETAILS, () => HttpResponse.json(BIORXIV_RESPONSE)),
    );
    const result = await adapter.verify({
      doi: '10.1101/2020.01.01.000001',
      claimedAuthor: 'Brown',
    });
    assert.equal(result.verified, true);
    assert.equal(result.metadata.source, 'biorxiv');
    assert.ok(requests() >= 2);
  });
});
