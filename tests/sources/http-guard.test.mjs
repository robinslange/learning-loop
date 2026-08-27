// tests/sources/http-guard.test.mjs : the shared adapter fetch leaves are
// SSRF-guarded. fetchJSON/fetchXML back all ~13 source adapters; url-guard
// claims to cover BOTH network entry points, so these must drive fetchGuarded
// rather than calling fetch() raw.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { fetchJSON, fetchXML } from '../../plugin/scripts/lib/sources/http.mjs';

let calls;
let origFetch;

function stubFetch(handler) {
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return handler(String(url), opts);
  };
}

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function redirectTo(location) {
  return { ok: false, status: 302, headers: new Headers({ location }), json: async () => null, text: async () => '' };
}

beforeEach(() => {
  calls = [];
  origFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = origFetch;
});

describe('sources/http SSRF guard', () => {
  it('refuses a loopback URL without touching the network', async () => {
    stubFetch(() => jsonResponse({ leaked: true }));
    assert.equal(await fetchJSON('http://127.0.0.1:8080/secret'), null);
    assert.equal(calls.length, 0);
  });

  it('refuses the cloud metadata address', async () => {
    stubFetch(() => jsonResponse({ leaked: true }));
    assert.equal(await fetchJSON('http://169.254.169.254/latest/meta-data/'), null);
    assert.equal(calls.length, 0);
  });

  it('refuses a non-http scheme', async () => {
    stubFetch(() => jsonResponse({ leaked: true }));
    assert.equal(await fetchXML('file:///etc/passwd'), null);
    assert.equal(calls.length, 0);
  });

  it('blocks a public host redirecting into loopback', async () => {
    // Modelled on real fetch: unless the caller asks for redirect:'manual',
    // the 302 is followed transparently and the loopback body comes back 200.
    stubFetch((url, opts) => {
      if (!url.startsWith('https://api.crossref.org')) return jsonResponse({ leaked: true });
      const hop = redirectTo('http://127.0.0.1:9000/pwned');
      return opts?.redirect === 'manual' ? hop : jsonResponse({ leaked: true });
    });
    assert.equal(await fetchJSON('https://api.crossref.org/works/10.1000/x'), null);
    assert.equal(calls.length, 1);
  });

  it('passes an allowed URL through and returns the parsed body', async () => {
    stubFetch(() => jsonResponse({ message: 'ok' }));
    assert.deepEqual(await fetchJSON('https://api.crossref.org/works/10.1000/x'), { message: 'ok' });
    assert.equal(calls.length, 1);
  });

  it('drives each hop manually with a timeout', async () => {
    stubFetch(() => jsonResponse({ message: 'ok' }));
    await fetchJSON('https://api.crossref.org/works/10.1000/x');
    assert.equal(calls[0].opts?.redirect, 'manual');
    assert.ok(calls[0].opts?.signal, 'expected an AbortSignal on the hop fetch');
  });

  it('returns null on a non-2xx terminal response', async () => {
    stubFetch(() => ({ ok: false, status: 404, headers: new Headers(), json: async () => null, text: async () => '' }));
    assert.equal(await fetchJSON('https://api.crossref.org/works/missing'), null);
  });
});
