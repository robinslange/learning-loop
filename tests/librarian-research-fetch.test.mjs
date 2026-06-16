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
});
