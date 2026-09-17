import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { decodeEntities, htmlToText, stripTags } from '../plugin/scripts/lib/html-text.mjs';

// Each case in this block was run against the previous inline chain in web-fetch.mjs
// and leaked. They are regressions, not hypotheticals.
describe('htmlToText closes the bypasses the inline chain had', () => {
  it('does not rebuild markup from a double-escaped entity', () => {
    const out = htmlToText('hello &amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt; world');
    assert.equal(out, 'hello &lt;script&gt;alert(1)&lt;/script&gt; world');
    assert.ok(!/<script/i.test(out), 'a second decode pass would have produced <script>');
  });

  it('does not rebuild a trust envelope from a double-escaped entity', () => {
    const out = htmlToText('x &amp;lt;vault-note trust=&amp;quot;ok&amp;quot;&amp;gt; y');
    assert.ok(!/<vault-note/i.test(out), 'envelope markup must not survive extraction');
  });

  it('drops a script body that is never closed', () => {
    const out = htmlToText('<p>real text</p><script>var pwn=1;alert("leak")');
    assert.equal(out, 'real text');
  });

  it('drops a style body that is never closed', () => {
    assert.equal(htmlToText('<p>copy</p><style>.a{color:red}'), 'copy');
  });

  it('drops a tag that is never closed', () => {
    assert.equal(htmlToText('before <div class="x  after'), 'before');
  });
});

describe('htmlToText keeps what the page meant to show', () => {
  it('decodes a single-escaped entity exactly once', () => {
    assert.equal(htmlToText('if a &lt; b then'), 'if a < b then');
    assert.equal(htmlToText('A &amp; B'), 'A & B');
    assert.equal(htmlToText('a&nbsp;b'), 'a b');
  });

  it('decodes quot and apos', () => {
    assert.equal(htmlToText('say &quot;hi&quot; and &apos;bye&apos;'), 'say "hi" and \'bye\'');
  });

  it('keeps a bare less-than that is not a tag', () => {
    assert.equal(htmlToText('if a < b then'), 'if a < b then');
  });

  it('collapses whitespace and trims', () => {
    assert.equal(htmlToText('<p>  a\n\n  b  </p>'), 'a b');
  });

  it('removes a closed script and its body but keeps surrounding copy', () => {
    assert.equal(htmlToText('<script src="/x.js">junk()</script><p>body</p>'), 'body');
  });

  it('does not treat a tag-like word as a raw text element', () => {
    assert.equal(htmlToText('<scriptural>text</scriptural>'), 'text');
  });
});

describe('stripTags', () => {
  it('absorbs an interior < so no tag is rebuilt, matching how a tokenizer reads it', () => {
    assert.equal(stripTags('<scr<x>ipt>payload'), 'ipt>payload');
  });

  it('is idempotent, so no second pass is needed', () => {
    for (const s of ['<scr<x>ipt>payload', '<a><b', 'x > <a', '<<a>>', 'a<b>c<d']) {
      assert.equal(stripTags(stripTags(s)), stripTags(s), `not idempotent on ${JSON.stringify(s)}`);
    }
  });

  it('leaves entities alone for the caller to decode', () => {
    assert.equal(stripTags('<jats:p>a &amp; b</jats:p>'), 'a &amp; b');
  });

  it('is total on non-strings', () => {
    assert.equal(stripTags(null), '');
    assert.equal(stripTags(undefined), '');
  });
});

describe('decodeEntities', () => {
  it('never re-reads its own output', () => {
    assert.equal(decodeEntities('&amp;lt;'), '&lt;');
    assert.equal(decodeEntities('&amp;amp;'), '&amp;');
  });

  it('is case-insensitive on the entity name', () => {
    assert.equal(decodeEntities('&AMP;&LT;&GT;'), '&<>');
  });

  it('leaves an unknown entity untouched', () => {
    assert.equal(decodeEntities('&copy; &#39;'), '&copy; &#39;');
  });
});
