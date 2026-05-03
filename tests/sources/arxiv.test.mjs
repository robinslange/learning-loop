import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const ARXIV_ENTRY = `<?xml version="1.0" encoding="UTF-8"?>
<feed>
<entry>
  <id>http://arxiv.org/abs/1706.03762v5</id>
  <title>Attention Is All You Need</title>
  <summary>We propose a new simple network architecture, the Transformer. n = 512 workers.</summary>
  <published>2017-06-12T17:57:34Z</published>
  <author><name>Ashish Vaswani</name></author>
  <author><name>Noam Shazeer</name></author>
  <category term="cs.CL"/>
</entry>
</feed>`;

const ARXIV_ERROR = `<?xml version="1.0" encoding="UTF-8"?>
<feed>
<entry>
  <title>Error</title>
  <summary>no results for id_list</summary>
</entry>
</feed>`;

describe('arxiv adapter', () => {
  let originalFetch;
  let adapter;

  before(async () => {
    originalFetch = globalThis.fetch;
    adapter = (await import('../../scripts/lib/sources/adapters/arxiv.mjs')).default;
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  it('fetchById returns metadata on success', async () => {
    globalThis.fetch = async () => ({ ok: true, text: async () => ARXIV_ENTRY });
    const data = await adapter.fetchById('1706.03762');
    assert.equal(data.source, 'arxiv');
    assert.equal(data.arxivId, '1706.03762');
    assert.equal(data.title, 'Attention Is All You Need');
    assert.ok(data.authors.includes('Ashish Vaswani'));
    assert.equal(data.year, 2017);
    assert.equal(data.studyType, 'preprint');
  });

  it('fetchById returns null on error entry', async () => {
    globalThis.fetch = async () => ({ ok: true, text: async () => ARXIV_ERROR });
    const data = await adapter.fetchById('9999.99999');
    assert.equal(data, null);
  });

  it('fetchById returns null on fetch failure', async () => {
    globalThis.fetch = async () => ({ ok: false });
    const data = await adapter.fetchById('1234.5678');
    assert.equal(data, null);
  });

  it('verify returns verified:true for correct author', async () => {
    globalThis.fetch = async () => ({ ok: true, text: async () => ARXIV_ENTRY });
    const result = await adapter.verify({
      arxivId: '1706.03762',
      claimedAuthor: 'Vaswani',
      claimedYear: 2017,
    });
    assert.equal(result.verified, true);
  });

  it('verify returns wrong_author issue', async () => {
    globalThis.fetch = async () => ({ ok: true, text: async () => ARXIV_ENTRY });
    const result = await adapter.verify({
      arxivId: '1706.03762',
      claimedAuthor: 'Hinton',
      claimedYear: 2017,
    });
    assert.equal(result.verified, false);
    assert.ok(result.issues.find((i) => i.type === 'wrong_author'));
  });

  it('verify returns error on not found', async () => {
    globalThis.fetch = async () => ({ ok: true, text: async () => ARXIV_ERROR });
    const result = await adapter.verify({ arxivId: '9999.99999' });
    assert.equal(result.verified, false);
    assert.ok(result.error);
    assert.equal(result.metadata, null);
  });

  it('parseArxivEntry extracts authors correctly', async () => {
    const { parseArxivEntry } = await import('../../scripts/lib/sources/adapters/arxiv.mjs');
    const entry = `<entry>
      <id>http://arxiv.org/abs/2001.00001v1</id>
      <title>Test Paper</title>
      <summary>Abstract here.</summary>
      <published>2020-01-01T00:00:00Z</published>
      <author><name>Alice Smith</name></author>
      <author><name>Bob Jones</name></author>
    </entry>`;
    const data = parseArxivEntry(entry);
    assert.deepEqual(data.authors, ['Alice Smith', 'Bob Jones']);
    assert.equal(data.firstAuthor, 'Alice Smith');
    assert.equal(data.year, 2020);
  });
});
