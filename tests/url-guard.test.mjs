// tests/url-guard.test.mjs — SSRF gate for the plugin's only egress paths.
//
// web-guard.js denies WebFetch/WebSearch and routes the model to
// bin/source-gateway.mjs, so an unvalidated --url makes the gateway a proxy for
// any loopback/link-local service. web-fetch.mjs has the same exposure via URLs
// scraped out of (attacker-authorable) note bodies.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkFetchUrl,
  checkRedirect,
  fetchGuarded,
} from '../plugin/scripts/lib/sources/url-guard.mjs';
import { fetchText } from '../plugin/scripts/librarian/research/fetch.mjs';
import { runGateway } from '../plugin/bin/source-gateway.mjs';

describe('checkFetchUrl', () => {
  const blocked = [
    ['http://127.0.0.1:8791/admin', 'host_private_ip'],
    ['http://localhost:11434/api/tags', 'host_loopback'],
    // A trailing root dot resolves to the same host but is preserved by
    // `new URL()`, so an exact-match name check misses it.
    ['http://localhost.:11434/api/tags', 'host_loopback'],
    ['http://localhost../', 'host_loopback'],
    ['http://metadata.google.internal./computeMetadata/v1/', 'host_loopback'],
    ['http://foo.localhost./', 'host_loopback'],
    ['http://169.254.169.254/latest/meta-data/', 'host_private_ip'],
    ['http://[::1]:8080/', 'host_private_ip'],
    ['http://10.0.0.5/', 'host_private_ip'],
    ['http://192.168.1.1/', 'host_private_ip'],
    ['http://172.16.0.1/', 'host_private_ip'],
    ['http://172.31.255.255/', 'host_private_ip'],
    ['http://0.0.0.0/', 'host_private_ip'],
    ['http://100.64.0.1/', 'host_private_ip'],
    ['http://foo.internal/x', 'host_loopback'],
    // IPv4-mapped IPv6, BOTH spellings. new URL() rewrites the dotted-quad form
    // into hex, so a guard that matched only '::ffff:127.0.0.1' let
    // '::ffff:7f00:1' through — and that is the form it actually sees. Verified
    // reachable: fetch('http://[::ffff:7f00:1]:p/') hits 127.0.0.1.
    ['http://[::ffff:127.0.0.1]/', 'host_private_ip'],
    ['http://[::ffff:7f00:1]/', 'host_private_ip'],
    ['http://[::ffff:169.254.169.254]/', 'host_private_ip'],
    ['http://[::ffff:a9fe:a9fe]/', 'host_private_ip'],
    ['http://[::ffff:192.168.1.1]/', 'host_private_ip'],
    ['http://[::ffff:c0a8:101]/', 'host_private_ip'],
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
      'http://[::ffff:8.8.8.8]/', // mapped, but public — must not over-block
      'http://[::ffff:808:808]/', // same address, hex spelling
      'http://[2001:4860:4860::8888]/',
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

// A guard applied to the ORIGIN only is not a guard: `redirect: 'follow'` lets a
// public host 302 into loopback or IMDS behind a clean-looking URL. This was
// live on the gateway path (fetch-source -> fetchText), proven by a 302 into
// 127.0.0.1 returning the loopback body. fetchGuarded is the single hop loop
// both entry points now drive.
describe('fetchGuarded — every hop, not just the origin', () => {
  const res = (status, location) => ({
    ok: true,
    status,
    headers: { get: (k) => (k.toLowerCase() === 'location' ? location : null) },
    text: async () => 'BODY',
  });

  it('blocks a public origin that redirects into loopback', async () => {
    const hops = [];
    const out = await fetchGuarded('https://public.example.com/a', (u) => {
      hops.push(u);
      return Promise.resolve(res(302, 'http://127.0.0.1:8791/secret'));
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'redirect_host_private_ip');
    assert.deepEqual(hops, ['https://public.example.com/a'], 'must not fetch the loopback hop');
  });

  it('blocks a redirect into IMDS, including the mapped-IPv6 spelling', async () => {
    for (const target of ['http://169.254.169.254/latest/meta-data/', 'http://[::ffff:a9fe:a9fe]/']) {
      const out = await fetchGuarded('https://public.example.com/a', () =>
        Promise.resolve(res(302, target)),
      );
      assert.equal(out.ok, false, `${target} must be blocked`);
      assert.equal(out.reason, 'redirect_host_private_ip');
    }
  });

  it('blocks a private hop reached only on the second redirect', async () => {
    const chain = ['https://b.example.com/', 'http://10.0.0.5/'];
    let i = 0;
    const out = await fetchGuarded('https://a.example.com/', () =>
      Promise.resolve(res(302, chain[i++])),
    );
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'redirect_host_private_ip');
  });

  it('follows public redirects and returns the final response', async () => {
    let i = 0;
    const out = await fetchGuarded('https://a.example.com/', () =>
      Promise.resolve(i++ === 0 ? res(302, 'https://b.example.com/x') : res(200, null)),
    );
    assert.equal(out.ok, true);
    assert.equal(out.url, 'https://b.example.com/x');
  });

  it('caps redirect chains', async () => {
    let n = 0;
    const out = await fetchGuarded('https://a.example.com/', () =>
      Promise.resolve(res(302, `https://a.example.com/${n++}`)),
    );
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'too_many_redirects');
  });

  it('treats a stubbed response with no status/headers as terminal, not a redirect', async () => {
    const out = await fetchGuarded('https://a.example.com/', () =>
      Promise.resolve({ ok: true, text: async () => 'BODY' }),
    );
    assert.equal(out.ok, true);
  });
});

describe('fetchText (source-gateway fetch slot) validates hops', () => {
  it('blocks a 302 into loopback instead of returning its body', async () => {
    let call = 0;
    const fetchOverride = async () => {
      call++;
      if (call === 1) {
        return {
          ok: true,
          status: 302,
          headers: { get: (k) => (k.toLowerCase() === 'location' ? 'http://127.0.0.1:9/x' : null) },
          text: async () => '',
        };
      }
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => '<p>SECRET</p>' };
    };
    const out = await fetchText('https://public.example.com/a', { fetchOverride });
    assert.equal(out.ok, false);
    assert.match(out.reason, /^blocked_/);
    assert.doesNotMatch(out.text, /SECRET/);
    assert.equal(call, 1, 'must not issue the loopback hop');
  });

  it('rejects a loopback origin outright', async () => {
    let called = false;
    const out = await fetchText('http://127.0.0.1:11434/api/tags', {
      fetchOverride: async () => {
        called = true;
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => 'x' };
      },
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'blocked_host_private_ip');
    assert.equal(called, false);
  });
});
