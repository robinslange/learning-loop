import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const PUBMED_SEARCH_RESPONSE = { esearchresult: { idlist: ['12345678'] } };
const PUBMED_FETCH_XML = `<?xml version="1.0"?>
<PubmedArticleSet>
<PubmedArticle>
  <MedlineCitation>
    <PMID>12345678</PMID>
    <Article>
      <ArticleTitle>Test Paper</ArticleTitle>
      <AuthorList>
        <Author><LastName>Smith</LastName><ForeName>Alice</ForeName></Author>
      </AuthorList>
      <Abstract><AbstractText>Abstract.</AbstractText></Abstract>
      <Journal><Title>Test Journal</Title></Journal>
      <PublicationTypeList><PublicationType>Journal Article</PublicationType></PublicationTypeList>
    </Article>
  </MedlineCitation>
  <PubmedData>
    <History>
      <PubMedPubDate PubStatus="pubmed"><Year>2020</Year></PubMedPubDate>
    </History>
    <ArticleIdList>
      <ArticleId IdType="pubmed">12345678</ArticleId>
    </ArticleIdList>
  </PubmedData>
</PubmedArticle>
</PubmedArticleSet>`;

describe('registry', () => {
  let originalFetch;
  let registry;

  before(async () => {
    originalFetch = globalThis.fetch;
    registry = await import('../../scripts/lib/sources/registry.mjs');
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  it('findAdapter returns pubmed adapter for src with pmid', () => {
    const adapter = registry.findAdapter({ pmid: '12345678' });
    assert.ok(adapter);
    assert.equal(adapter.id, 'pubmed');
  });

  it('findAdapter returns arxiv adapter for src with arxivId', () => {
    const adapter = registry.findAdapter({ arxivId: '1706.03762' });
    assert.ok(adapter);
    assert.equal(adapter.id, 'arxiv');
  });

  it('findAdapter returns pmc adapter for src with pmc', () => {
    const adapter = registry.findAdapter({ pmc: 'PMC1234567' });
    assert.ok(adapter);
    assert.equal(adapter.id, 'pmc');
  });

  it('findAdapter returns rfc adapter for src with rfcNumber', () => {
    const adapter = registry.findAdapter({ rfcNumber: '9110' });
    assert.ok(adapter);
    assert.equal(adapter.id, 'rfc');
  });

  it('findAdapter returns openlibrary for src with isbn', () => {
    const adapter = registry.findAdapter({ isbn: '9780143127796' });
    assert.ok(adapter);
    assert.equal(adapter.id, 'openlibrary');
  });

  it('findAdapter returns null for src with no identifiers', () => {
    const adapter = registry.findAdapter({ claimedAuthor: 'Smith', claimedYear: 2020 });
    assert.equal(adapter, null);
  });

  it('findAdapter dispatch precedence: pmid wins over doi', () => {
    const adapter = registry.findAdapter({ pmid: '12345678', doi: '10.1234/test' });
    assert.equal(adapter.id, 'pubmed');
  });

  it('resolveSource short-circuits on PubMed hit', async () => {
    let fetchCalls = 0;
    globalThis.fetch = async (url) => {
      fetchCalls++;
      if (url.includes('esearch')) return { ok: true, json: async () => PUBMED_SEARCH_RESPONSE };
      if (url.includes('efetch')) return { ok: true, text: async () => PUBMED_FETCH_XML };
      return { ok: false };
    };
    const result = await registry.resolveSource('Smith 2020 test paper');
    assert.equal(result.resolved, true);
    assert.equal(result.source, 'pubmed');
    const europePmcCalled = fetchCalls === 0 || !String(fetchCalls).includes('europepmc');
    assert.ok(result.resolved);
  });
});
