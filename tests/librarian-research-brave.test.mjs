// tests/librarian-research-brave.test.mjs : Brave Search client.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { search } from '../plugin/scripts/librarian/research/brave.mjs';

describe('brave search client', () => {
  it('shapes the request and parses results', async () => {
    let capturedUrl, capturedHeaders;
    const fetchOverride = async (url, opts) => {
      capturedUrl = url;
      capturedHeaders = opts.headers;
      return {
        ok: true,
        json: async () => ({
          web: {
            results: [
              { url: 'https://a.com', title: 'A', description: 'snippet A' },
              { url: 'https://b.com', title: 'B', description: 'snippet B' },
            ],
          },
        }),
      };
    };
    const out = await search('caffeine half life', { count: 2, apiKey: 'KEY', fetchOverride });
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], { url: 'https://a.com', title: 'A', snippet: 'snippet A' });
    assert.match(capturedUrl, /search\.brave\.com.*q=caffeine%20half%20life/);
    assert.match(capturedUrl, /count=2/);
    assert.equal(capturedHeaders['X-Subscription-Token'], 'KEY');
  });

  it('returns empty array on HTTP error', async () => {
    const fetchOverride = async () => ({ ok: false, status: 429, json: async () => ({}) });
    const out = await search('x', { apiKey: 'KEY', fetchOverride });
    assert.deepEqual(out, []);
  });

  it('returns empty array when no api key resolves', async () => {
    const fetchOverride = async () => {
      throw new Error('should not be called');
    };
    const out = await search('x', { apiKey: null, fetchOverride });
    assert.deepEqual(out, []);
  });
});
