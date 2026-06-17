// tests/librarian-research-fetch.test.mjs : fetch + HTML-to-text.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText, fetchText } from '../plugin/scripts/librarian/research/fetch.mjs';

describe('htmlToText', () => {
  it('strips scripts, styles, and tags, keeps prose, decodes entities', () => {
    const html = `<html><head><style>.x{color:red}</style><script>var a=1;</script></head>
      <body><nav>Home About</nav><h1>Title</h1><p>First sentence.</p><p>Second &amp; third.</p></body></html>`;
    const text = htmlToText(html);
    assert.match(text, /Title/);
    assert.match(text, /First sentence\./);
    assert.match(text, /Second & third\./);
    assert.doesNotMatch(text, /var a=1/);
    assert.doesNotMatch(text, /color:red/);
  });

  it('drops an unclosed script/style block (no matching end tag)', () => {
    const text = htmlToText('<p>Keep this.</p><script>leaked = "secret"; while(1){}');
    assert.match(text, /Keep this\./);
    assert.doesNotMatch(text, /leaked/);
  });
});

describe('fetchText', () => {
  it('returns ok:false reason:http_403 on HTTP error, no throw', async () => {
    const fetchOverride = async () => ({ ok: false, status: 403, text: async () => '' });
    const out = await fetchText('https://paywall.com', { fetchOverride });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'http_403');
    assert.equal(out.text, '');
  });

  it('returns ok:true with extracted text on success', async () => {
    const fetchOverride = async () => ({
      ok: true,
      status: 200,
      text: async () => '<p>Hello world.</p>',
    });
    const out = await fetchText('https://good.com', { fetchOverride });
    assert.equal(out.ok, true);
    assert.match(out.text, /Hello world\./);
  });

  it('returns ok:false reason:timeout on abort', async () => {
    const fetchOverride = async () => {
      const e = new Error('aborted');
      e.name = 'TimeoutError';
      throw e;
    };
    const out = await fetchText('https://slow.com', { fetchOverride });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'timeout');
  });

  it('returns ok:false reason:fetch_error on generic network failure', async () => {
    const fetchOverride = async () => {
      throw new Error('ECONNREFUSED');
    };
    const out = await fetchText('https://down.com', { fetchOverride });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'fetch_error');
  });

  it('sends Accept: text/html so servers prefer an HTML representation', async () => {
    let seenHeaders;
    const fetchOverride = async (_url, init) => {
      seenHeaders = init.headers;
      return { ok: true, status: 200, headers: hdrs(), text: async () => '<p>x</p>' };
    };
    await fetchText('https://good.com', { fetchOverride });
    assert.match(seenHeaders.Accept || seenHeaders.accept || '', /text\/html/);
  });

  it('short-circuits a non-text Content-Type to ok:false reason:non_html (no body read)', async () => {
    let bodyRead = false;
    const fetchOverride = async () => ({
      ok: true,
      status: 200,
      headers: hdrs({ 'content-type': 'application/pdf' }),
      text: async () => {
        bodyRead = true;
        return 'PDFBYTES';
      },
    });
    const out = await fetchText('https://x.com/paper.pdf', { fetchOverride });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'non_html');
    assert.equal(bodyRead, false, 'must not buffer a binary body');
  });

  it('rejects an oversized body by Content-Length before reading it', async () => {
    let bodyRead = false;
    const fetchOverride = async () => ({
      ok: true,
      status: 200,
      headers: hdrs({ 'content-type': 'text/html', 'content-length': String(50 * 1024 * 1024) }),
      text: async () => {
        bodyRead = true;
        return 'x';
      },
    });
    const out = await fetchText('https://x.com/huge', { fetchOverride, maxBytes: 5 * 1024 * 1024 });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'too_large');
    assert.equal(bodyRead, false);
  });

  it('still works when the mock provides no headers (back-compat)', async () => {
    const fetchOverride = async () => ({ ok: true, status: 200, text: async () => '<p>Hi.</p>' });
    const out = await fetchText('https://good.com', { fetchOverride });
    assert.equal(out.ok, true);
    assert.match(out.text, /Hi\./);
  });
});

// Minimal Headers-like stub: case-insensitive get(), matching the WHATWG shape.
function hdrs(map = {}) {
  const lower = Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (k) => lower[k.toLowerCase()] ?? null };
}
