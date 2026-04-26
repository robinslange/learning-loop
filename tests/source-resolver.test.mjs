import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const runId = randomBytes(8).toString('hex');
const TEMP_ROOT = join(tmpdir(), `ll-source-resolver-${runId}`);
const TEMP_DATA = join(TEMP_ROOT, 'plugin-data');

let __test__;

describe('source-resolver check-claims', () => {
  let originalFetch;

  before(async () => {
    mkdirSync(TEMP_DATA, { recursive: true });
    process.env.CLAUDE_PLUGIN_DATA = TEMP_DATA;
    originalFetch = globalThis.fetch;
    const mod = await import(`../scripts/source-resolver.mjs?bust=${runId}`);
    __test__ = mod.__test__;
  });

  after(() => {
    globalThis.fetch = originalFetch;
    delete process.env.CLAUDE_PLUGIN_DATA;
    rmSync(TEMP_ROOT, { recursive: true, force: true });
  });

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('isBlockedFetch matches paywall/PDF domains in WEB_FETCH_BLOCKLIST', () => {
    const { isBlockedFetch, WEB_FETCH_BLOCKLIST } = __test__;
    assert.ok(Array.isArray(WEB_FETCH_BLOCKLIST));
    assert.ok(WEB_FETCH_BLOCKLIST.length > 0);

    assert.equal(isBlockedFetch('https://www.sciencedirect.com/article/X'), true);
    assert.equal(isBlockedFetch('https://linkinghub.elsevier.com/foo'), true);
    assert.equal(isBlockedFetch('https://doi.org/10.1234/abc'), true);
    assert.equal(isBlockedFetch('https://example.com/paper.pdf'), true);

    assert.equal(isBlockedFetch('https://example.com/article'), false);
    assert.equal(isBlockedFetch('https://en.wikipedia.org/wiki/Foo'), false);
  });

  it('check-claims fetches page text for non-academic URL and matches numeric claim', async () => {
    let fetchCalls = 0;
    globalThis.fetch = async (url) => {
      fetchCalls++;
      return {
        ok: true,
        text: async () =>
          '<html><body><p>The study found that 80% of users prefer X over Y.</p></body></html>',
      };
    };

    const notePath = join(TEMP_ROOT, 'note-page.md');
    const content = [
      '---',
      'tags: [test]',
      '---',
      '# Note',
      '',
      'See [the article](https://example.com/article) which reports 80% adoption.',
      '',
    ].join('\n');
    writeFileSync(notePath, content);

    const results = await __test__.checkClaims(notePath);

    assert.ok(fetchCalls >= 1, 'fetch should have been called for non-blocklisted URL');
    assert.ok(Array.isArray(results));
    assert.ok(results.length >= 1, 'should have at least one claim row');

    const eighty = results.find(r => r.claim === '80');
    assert.ok(eighty, 'expected a result for the 80% claim');
    assert.equal(eighty.source_kind, 'page');
    assert.equal(eighty.url, 'https://example.com/article');
    assert.equal(eighty.in_abstract, true);
    assert.match(eighty.abstract_excerpt || '', /80%/);
  });

  it('check-claims skips WEB_FETCH_BLOCKLIST domains without fetching', async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return { ok: true, text: async () => '<html>blocked</html>' };
    };

    const notePath = join(TEMP_ROOT, 'note-blocked.md');
    const content = [
      '---',
      'tags: [test]',
      '---',
      '# Note',
      '',
      'See [the paper](https://www.sciencedirect.com/article/X) which reports 42% something.',
      '',
    ].join('\n');
    writeFileSync(notePath, content);

    const results = await __test__.checkClaims(notePath);

    assert.equal(fetchCalls, 0, 'fetch must not be called for blocklisted domains');
    assert.ok(Array.isArray(results));
    assert.equal(
      results.length,
      0,
      'no rows expected when the only source is blocklisted and has no PMID/DOI',
    );
  });

  it('check-claims returns [] when note has no quantitative numbers', async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return { ok: true, text: async () => '<html>page</html>' };
    };

    const notePath = join(TEMP_ROOT, 'note-no-numbers.md');
    const content = [
      '---',
      'tags: [test]',
      '---',
      '# Note',
      '',
      'See [the article](https://example.com/article).',
      '',
      'No specific quantitative claims here.',
      '',
    ].join('\n');
    writeFileSync(notePath, content);

    const results = await __test__.checkClaims(notePath);

    assert.deepEqual(results, []);
    assert.equal(fetchCalls, 0, 'no fetch should happen if no numbers to verify');
  });
});

describe('fetchPageText error surfacing', () => {
  let originalFetch;
  before(() => {
    originalFetch = globalThis.fetch;
  });
  after(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns { ok: false, kind: "timeout" } on AbortError', async () => {
    globalThis.fetch = async () => {
      throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    };
    const { __test__ } = await import(
      `../scripts/source-resolver.mjs?bust=${randomBytes(4).toString('hex')}`
    );
    const result = await __test__.fetchPageText('https://example.com/x');
    assert.equal(result.ok, false);
    assert.equal(result.kind, 'timeout');
  });

  it('returns { ok: false, kind: "http", status } on 4xx', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 404 });
    const { __test__ } = await import(
      `../scripts/source-resolver.mjs?bust=${randomBytes(4).toString('hex')}`
    );
    const result = await __test__.fetchPageText('https://example.com/y');
    assert.equal(result.ok, false);
    assert.equal(result.kind, 'http');
    assert.equal(result.status, 404);
  });

  it('returns { ok: true, text } on success', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      text: async () => '<html><body>hello world</body></html>',
    });
    const { __test__ } = await import(
      `../scripts/source-resolver.mjs?bust=${randomBytes(4).toString('hex')}`
    );
    const result = await __test__.fetchPageText('https://example.com/z');
    assert.equal(result.ok, true);
    assert.match(result.text, /hello world/);
  });
});
