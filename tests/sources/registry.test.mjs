import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { HttpResponse, http, startMockNetwork } from '../helpers/msw.mjs';

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/:tool';
const server = startMockNetwork();

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
  let registry;

  before(async () => {
    registry = await import('../../plugin/scripts/lib/sources/registry.mjs');
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
    // Only PubMed's two endpoints are registered. Under
    // `onUnhandledRequest: 'error'` a call to any later provider is a failure,
    // which is the actual claim in the test's name -- the old version computed
    // an unused boolean and then asserted `result.resolved` twice.
    server.use(
      http.get(EUTILS, ({ params }) =>
        params.tool.startsWith('esearch')
          ? HttpResponse.json(PUBMED_SEARCH_RESPONSE)
          : HttpResponse.xml(PUBMED_FETCH_XML),
      ),
    );
    const result = await registry.resolveSource('Smith 2020 test paper');
    assert.equal(result.resolved, true);
    assert.equal(result.source, 'pubmed');
  });
});
