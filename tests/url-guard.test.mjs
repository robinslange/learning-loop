// tests/url-guard.test.mjs — SSRF gate for the plugin's only egress paths.
//
// web-guard.js denies WebFetch/WebSearch and routes the model to
// bin/source-gateway.mjs, so an unvalidated --url makes the gateway a proxy for
// any loopback/link-local service. web-fetch.mjs has the same exposure via URLs
// scraped out of (attacker-authorable) note bodies.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkFetchUrl, checkRedirect } from '../plugin/scripts/lib/sources/url-guard.mjs';
import { runGateway } from '../plugin/bin/source-gateway.mjs';

describe('checkFetchUrl', () => {
  const blocked = [
    ['http://127.0.0.1:8791/admin', 'host_private_ip'],
    ['http://localhost:11434/api/tags', 'host_loopback'],
    ['http://169.254.169.254/latest/meta-data/', 'host_private_ip'],
    ['http://[::1]:8080/', 'host_private_ip'],
    ['http://10.0.0.5/', 'host_private_ip'],
    ['http://192.168.1.1/', 'host_private_ip'],
    ['http://172.16.0.1/', 'host_private_ip'],
    ['http://172.31.255.255/', 'host_private_ip'],
    ['http://0.0.0.0/', 'host_private_ip'],
    ['http://100.64.0.1/', 'host_private_ip'],
    ['http://foo.internal/x', 'host_loopback'],
  ];
  for (const [url, reason] of blocked) {
    it(`blocks ${url}`, () => {
      const r = checkFetchUrl(url);
      assert.equal(r.ok, false, `${url} must be blocked`);
      assert.equal(r.reason, reason);
    });
  }

  it('blocks non-http(s) schemes', () => {
    for (const u of ['file:///etc/passwd', 'gopher://x/', 'ftp://x/a', 'data:text/plain,hi']) {
      const r = checkFetchUrl(u);
      assert.equal(r.ok, false, `${u} must be blocked`);
      assert.match(r.reason, /^scheme_not_allowed:/);
    }
  });

  it('blocks empty / unparseable input', () => {
    assert.equal(checkFetchUrl('').reason, 'url_missing');
    assert.equal(checkFetchUrl(null).reason, 'url_missing');
    assert.equal(checkFetchUrl('not a url').reason, 'url_unparseable');
  });

  it('allows ordinary public URLs', () => {
    for (const u of [
      'https://example.com/a',
      'http://93.184.216.34/',
      'https://sub.domain.co.nz/x?y=1#z',
      'https://172.32.0.1/', // just outside 172.16/12
      'https://11.0.0.1/', // just outside 10/8
    ]) {
      assert.equal(checkFetchUrl(u).ok, true, `${u} must be allowed`);
    }
  });

  it('does not treat octal/hex IP spellings as safe public hosts', () => {
    // These must not resolve to an ALLOWED literal-IPv4 path. Whatever the
    // reason, the one unacceptable outcome is ok:true for a loopback alias.
    for (const u of ['http://0177.0.0.1/', 'http://0x7f000001/', 'http://2130706433/']) {
      const r = checkFetchUrl(u);
      if (r.ok) assert.fail(`${u} must not be allowed as a public host`);
    }
  });
});

describe('checkRedirect', () => {
  it('blocks a public host redirecting into cloud IMDS', () => {
    const r = checkRedirect('http://169.254.169.254/latest', 'https://public.example.com/');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'redirect_host_private_ip');
  });

  it('blocks a relative redirect resolving to a blocked scheme', () => {
    assert.equal(checkRedirect('file:///etc/passwd', 'https://x.com/').ok, false);
  });

  it('allows a public-to-public redirect', () => {
    const r = checkRedirect('/next', 'https://example.com/first');
    assert.equal(r.ok, true);
    assert.equal(r.url.href, 'https://example.com/next');
  });
});

describe('fetchPageText redirect loop', () => {
  it('treats a response with no status/headers as terminal, not a redirect', async () => {
    // Regression: the manual-redirect loop first gated on `res.status < 300`.
    // A stubbed fetch returning {ok, text} has status === undefined, and
    // `undefined < 300` is false — so every mocked response looked like a
    // redirect and the loop spun until MAX_REDIRECTS. Caught by
    // source-resolver.test.mjs; pinned here at the unit level.
    const { fetchPageText } = await import('../plugin/scripts/lib/sources/web-fetch.mjs');
    const saved = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return { ok: true, text: async () => '<html><body><p>hello</p></body></html>' };
    };
    try {
      const out = await fetchPageText('https://example.com/a');
      assert.equal(calls, 1, 'a terminal response must be fetched exactly once');
      assert.notEqual(out.kind, 'too_many_redirects');
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('blocks a 302 from a public host into loopback', async () => {
    const { fetchPageText } = await import('../plugin/scripts/lib/sources/web-fetch.mjs');
    const saved = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: false,
      status: 302,
      headers: { get: (h) => (h === 'location' ? 'http://127.0.0.1:11434/api/tags' : null) },
      text: async () => '',
    });
    try {
      const out = await fetchPageText('https://public.example.com/');
      assert.equal(out.ok, false);
      assert.equal(out.kind, 'blocked');
      assert.equal(out.reason, 'redirect_host_private_ip');
    } finally {
      globalThis.fetch = saved;
    }
  });
});

describe('source-gateway fetch verb', () => {
  const deps = {
    resolveSlot: () => ({
      id: 'test-source',
      fetch: async () => ({ ok: true, text: 'SHOULD NOT BE REACHED' }),
    }),
    sessionId: '',
    pluginData: null,
  };

  it('refuses a loopback --url without calling the source', async () => {
    const out = await runGateway(['fetch', '--url', 'http://127.0.0.1:8791/admin'], deps);
    assert.equal(out.doc.ok, false);
    assert.equal(out.doc.reason, 'blocked_url:host_private_ip');
    assert.notEqual(out.doc.text, 'SHOULD NOT BE REACHED');
  });

  it('refuses a file: --url', async () => {
    const out = await runGateway(['fetch', '--url', 'file:///etc/passwd'], deps);
    assert.equal(out.doc.ok, false);
    assert.match(out.doc.reason, /^blocked_url:scheme_not_allowed/);
  });

  it('does not consume fetch budget on a blocked url', async () => {
    let bumped = 0;
    const store = { n: 0, bump: () => bumped++ };
    await runGateway(['fetch', '--url', 'http://169.254.169.254/'], {
      ...deps,
      budgetStore: store,
    });
    assert.equal(bumped, 0, 'a rejected URL must not spend the session budget');
  });

  it('still allows a public url through to the source', async () => {
    const out = await runGateway(['fetch', '--url', 'https://example.com/a'], deps);
    assert.equal(out.doc.ok, true);
    assert.equal(out.source_used, 'test-source');
  });
});
