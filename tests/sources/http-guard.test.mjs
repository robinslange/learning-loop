// tests/sources/http-guard.test.mjs : the shared adapter fetch leaves are
// SSRF-guarded. fetchJSON/fetchXML back all ~13 source adapters; url-guard
// claims to cover BOTH network entry points, so these must drive fetchGuarded
// rather than calling fetch() raw.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { fetchJSON, fetchXML } from '../../plugin/scripts/lib/sources/http.mjs';
import {
  HttpResponse,
  countRequests,
  http,
  redirectTo,
  startMockNetwork,
} from '../helpers/msw.mjs';

const CROSSREF = 'https://api.crossref.org/works/*';
const server = startMockNetwork();

describe('sources/http SSRF guard', () => {
  it('refuses a loopback URL without touching the network', async () => {
    const requests = countRequests();
    server.use(http.get('http://127.0.0.1:8080/secret', () => HttpResponse.json({ leaked: true })));
    assert.equal(await fetchJSON('http://127.0.0.1:8080/secret'), null);
    assert.equal(requests(), 0);
  });

  it('refuses the cloud metadata address', async () => {
    const requests = countRequests();
    server.use(
      http.get('http://169.254.169.254/latest/meta-data/', () =>
        HttpResponse.json({ leaked: true }),
      ),
    );
    assert.equal(await fetchJSON('http://169.254.169.254/latest/meta-data/'), null);
    assert.equal(requests(), 0);
  });

  it('refuses a non-http scheme', async () => {
    const requests = countRequests();
    assert.equal(await fetchXML('file:///etc/passwd'), null);
    assert.equal(requests(), 0);
  });

  it('blocks a public host redirecting into loopback', async () => {
    // The loopback hop has a handler that would serve a body: the assertion is
    // that the guard stops the request, not that the address happens to be
    // unreachable from a test runner.
    const requests = countRequests();
    server.use(
      http.get(CROSSREF, () => redirectTo('http://127.0.0.1:9000/pwned')),
      http.get('http://127.0.0.1:9000/pwned', () => HttpResponse.json({ leaked: true })),
    );
    assert.equal(await fetchJSON('https://api.crossref.org/works/10.1000/x'), null);
    assert.equal(requests(), 1, 'the loopback hop must never be issued');
  });

  it('passes an allowed URL through and returns the parsed body', async () => {
    server.use(http.get(CROSSREF, () => HttpResponse.json({ message: 'ok' })));
    assert.deepEqual(await fetchJSON('https://api.crossref.org/works/10.1000/x'), {
      message: 'ok',
    });
  });

  it('drives each hop manually with a bounded signal', async () => {
    // A spy over the real boundary, not a stub: MSW still answers, so the
    // response is a real one. `request.redirect` is readable from a handler,
    // but `signal` is not -- every Request carries one whether the caller
    // passed it or not -- so the init has to be inspected here.
    server.use(http.get(CROSSREF, () => HttpResponse.json({ message: 'ok' })));
    const inits = [];
    const inner = globalThis.fetch;
    globalThis.fetch = (url, opts) => {
      inits.push(opts);
      return inner(url, opts);
    };
    try {
      await fetchJSON('https://api.crossref.org/works/10.1000/x');
    } finally {
      globalThis.fetch = inner;
    }
    assert.equal(inits[0]?.redirect, 'manual');
    assert.ok(inits[0]?.signal, 'expected an AbortSignal on the hop fetch');
  });

  it('returns null on a non-2xx terminal response', async () => {
    // The body must be non-null, or an empty body satisfies the assertion on
    // its own and the case passes with the ok-check removed.
    server.use(
      http.get(CROSSREF, () => HttpResponse.json({ error: 'not found' }, { status: 404 })),
    );
    assert.equal(await fetchJSON('https://api.crossref.org/works/missing'), null);
    assert.equal(await fetchXML('https://api.crossref.org/works/missing'), null);
  });
});
