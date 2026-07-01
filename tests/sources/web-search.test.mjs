import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import braveSource from '../../plugin/scripts/lib/sources/web-search.mjs';

const fetchOverride = async () => ({
  ok: true, status: 200,
  json: async () => ({ web: { results: [{ url: 'https://a', title: 'A', description: 'snip' }] } }),
});

describe('brave query source', () => {
  it('declares query capability and web origin', () => {
    assert.deepEqual(braveSource.capabilities, ['query']);
    assert.equal(braveSource.origin, 'web');
  });
  it('normalizes brave results to Hit shape with origin+sourceId', async () => {
    const hits = await braveSource.query('rust async', { apiKey: 'k', fetchOverride });
    assert.deepEqual(hits, [{ url: 'https://a', title: 'A', snippet: 'snip', origin: 'web', sourceId: 'brave' }]);
  });
  it('returns [] when brave returns nothing (empty results)', async () => {
    const emptyFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ web: { results: [] } }),
    });
    const hits = await braveSource.query('x', { apiKey: 'k', fetchOverride: emptyFetch });
    assert.deepEqual(hits, []);
  });
});
