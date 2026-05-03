import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const PUBMED_FETCH_RESPONSE = `<?xml version="1.0" encoding="utf-8"?>
<PubmedArticleSet>
<PubmedArticle>
  <MedlineCitation>
    <PMID>12345678</PMID>
    <Article>
      <ArticleTitle>Attention mechanisms in neural networks</ArticleTitle>
      <AuthorList>
        <Author>
          <LastName>Vaswani</LastName>
          <ForeName>Ashish</ForeName>
        </Author>
        <Author>
          <LastName>Shazeer</LastName>
          <ForeName>Noam</ForeName>
        </Author>
      </AuthorList>
      <Abstract>
        <AbstractText>We present a novel architecture n = 512.</AbstractText>
      </Abstract>
      <Journal>
        <Title>NeurIPS</Title>
        <JournalIssue>
          <PubDate>
            <Year>2017</Year>
          </PubDate>
        </JournalIssue>
      </Journal>
      <PublicationTypeList>
        <PublicationType>Journal Article</PublicationType>
      </PublicationTypeList>
    </Article>
    <MedlineJournalInfo/>
    <ArticleIdList>
      <ArticleId IdType="doi">10.1234/attention</ArticleId>
    </ArticleIdList>
  </MedlineCitation>
  <PubmedData>
    <ArticleIdList>
      <ArticleId IdType="pubmed">12345678</ArticleId>
    </ArticleIdList>
  </PubmedData>
</PubmedArticle>
</PubmedArticleSet>`;

describe('pubmed adapter', () => {
  let originalFetch;
  let adapter;

  before(async () => {
    originalFetch = globalThis.fetch;
    adapter = (await import('../../scripts/lib/sources/adapters/pubmed.mjs')).default;
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  it('pubmedFetch returns metadata on success', async () => {
    globalThis.fetch = async (url) => {
      if (url.includes('efetch')) return { ok: true, text: async () => PUBMED_FETCH_RESPONSE };
      return { ok: false };
    };
    const data = await adapter.fetchById('12345678');
    assert.equal(data.source, 'pubmed');
    assert.equal(data.pmid, '12345678');
    assert.equal(data.title, 'Attention mechanisms in neural networks');
    assert.ok(data.authors.includes('Vaswani Ashish'));
    assert.equal(data.firstAuthor, 'Vaswani Ashish');
  });

  it('pubmedFetch returns null on 404', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 404 });
    const data = await adapter.fetchById('99999999');
    assert.equal(data, null);
  });

  it('verify returns verified:true on correct first author', async () => {
    globalThis.fetch = async (url) => {
      if (url.includes('efetch')) return { ok: true, text: async () => PUBMED_FETCH_RESPONSE };
      return { ok: false };
    };
    const result = await adapter.verify({
      pmid: '12345678',
      claimedAuthor: 'Vaswani',
      claimedYear: 2017,
    });
    assert.equal(result.verified, true);
    assert.deepEqual(result.issues, []);
  });

  it('verify returns wrong_author issue for wrong first author', async () => {
    globalThis.fetch = async (url) => {
      if (url.includes('efetch')) return { ok: true, text: async () => PUBMED_FETCH_RESPONSE };
      return { ok: false };
    };
    const result = await adapter.verify({
      pmid: '12345678',
      claimedAuthor: 'Hinton',
      claimedYear: 2017,
    });
    assert.equal(result.verified, false);
    const wrongAuthor = result.issues.find((i) => i.type === 'wrong_author');
    assert.ok(wrongAuthor);
    assert.equal(wrongAuthor.severity, 'high');
  });

  it('verify returns author_not_first for non-first author', async () => {
    globalThis.fetch = async (url) => {
      if (url.includes('efetch')) return { ok: true, text: async () => PUBMED_FETCH_RESPONSE };
      return { ok: false };
    };
    const result = await adapter.verify({
      pmid: '12345678',
      claimedAuthor: 'Shazeer',
      claimedYear: 2017,
    });
    assert.equal(result.verified, false);
    const issue = result.issues.find((i) => i.type === 'author_not_first');
    assert.ok(issue);
    assert.equal(issue.severity, 'medium');
  });

  it('verify returns wrong_year issue for wrong year', async () => {
    globalThis.fetch = async (url) => {
      if (url.includes('efetch')) return { ok: true, text: async () => PUBMED_FETCH_RESPONSE };
      return { ok: false };
    };
    const result = await adapter.verify({
      pmid: '12345678',
      claimedAuthor: 'Vaswani',
      claimedYear: 2010,
    });
    assert.equal(result.verified, false);
    const issue = result.issues.find((i) => i.type === 'wrong_year');
    assert.ok(issue);
  });

  it('verify returns error on 404', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 404 });
    const result = await adapter.verify({
      pmid: '99999999',
      claimedAuthor: 'Smith',
      claimedYear: 2020,
    });
    assert.equal(result.verified, false);
    assert.ok(result.error);
  });
});
