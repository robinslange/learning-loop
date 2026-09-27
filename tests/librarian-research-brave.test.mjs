// tests/librarian-research-brave.test.mjs : Brave Search client.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { search } from '../plugin/scripts/librarian/research/brave.mjs';
import { HttpResponse, countRequests, http, startMockNetwork } from './helpers/msw.mjs';

const ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const server = startMockNetwork();

describe('brave search client', () => {
  it('shapes the request and parses results', async () => {
    let url, token;
    server.use(
      http.get(ENDPOINT, ({ request }) => {
        url = new URL(request.url);
        token = request.headers.get('x-subscription-token');
        return HttpResponse.json({
          web: {
            results: [
              { url: 'https://a.com', title: 'A', description: 'snippet A' },
              { url: 'https://b.com', title: 'B', description: 'snippet B' },
            ],
          },
        });
      }),
    );

    const out = await search('caffeine half life', { count: 2, apiKey: 'KEY' });
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], { url: 'https://a.com', title: 'A', snippet: 'snippet A' });
    // Read the parsed query, not the raw string: %20 and + are both correct
    // encodings of the same space, and an assertion on one spelling breaks on
    // the other for no reason a caller would care about.
    assert.equal(url.searchParams.get('q'), 'caffeine half life');
    assert.equal(url.searchParams.get('count'), '2');
    assert.equal(token, 'KEY');
  });

  it('returns empty array on HTTP error', async () => {
    server.use(http.get(ENDPOINT, () => HttpResponse.json({}, { status: 429 })));
    const out = await search('x', { apiKey: 'KEY' });
    assert.deepEqual(out, []);
  });

  it('returns empty array when the response body is not the documented shape', async () => {
    // Brave answers 200 with an error envelope when the key is over quota.
    // The old stub could only express `ok:false`, so nothing covered a 200
    // whose `web.results` is missing.
    server.use(http.get(ENDPOINT, () => HttpResponse.json({ type: 'ErrorResponse' })));
    const out = await search('x', { apiKey: 'KEY' });
    assert.deepEqual(out, []);
  });

  it('returns empty array when no api key resolves', async () => {
    // `''`, not `null`: `opts.apiKey ?? getApiKey()` treats null as "not
    // supplied" and falls through to the keychain, so on a machine that has a
    // Brave key the old version of this test issued a real request to the live
    // API and passed only because `search` swallows every failure.
    const requests = countRequests(server);
    const out = await search('x', { apiKey: '' });
    assert.deepEqual(out, []);
    assert.equal(requests(), 0, 'a missing key must not reach the network');
  });
});
