import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import pubmed from '../../plugin/scripts/lib/sources/adapters/pubmed.mjs';
import arxiv from '../../plugin/scripts/lib/sources/adapters/arxiv.mjs';
import crossref from '../../plugin/scripts/lib/sources/adapters/crossref.mjs';
import europepmc from '../../plugin/scripts/lib/sources/adapters/europepmc.mjs';
import semanticScholar from '../../plugin/scripts/lib/sources/adapters/semantic-scholar.mjs';
import openalex from '../../plugin/scripts/lib/sources/adapters/openalex.mjs';
import dblp from '../../plugin/scripts/lib/sources/adapters/dblp.mjs';
import biorxiv from '../../plugin/scripts/lib/sources/adapters/biorxiv.mjs';
import unpaywall from '../../plugin/scripts/lib/sources/adapters/unpaywall.mjs';
import rfc from '../../plugin/scripts/lib/sources/adapters/rfc.mjs';
import openlibrary from '../../plugin/scripts/lib/sources/adapters/openlibrary.mjs';
import chembl from '../../plugin/scripts/lib/sources/adapters/chembl.mjs';
import pmc from '../../plugin/scripts/lib/sources/adapters/pmc.mjs';

const ADAPTERS = [
  pubmed,
  arxiv,
  crossref,
  europepmc,
  semanticScholar,
  openalex,
  dblp,
  biorxiv,
  unpaywall,
  rfc,
  openlibrary,
  chembl,
  pmc,
];

describe('adapter contract', () => {
  for (const adapter of ADAPTERS) {
    it(`${adapter.id} has required shape`, () => {
      assert.equal(typeof adapter.id, 'string');
      assert.ok(adapter.id.length > 0);
      if (adapter.matches !== undefined) assert.equal(typeof adapter.matches, 'function');
      if (adapter.search !== undefined) assert.equal(typeof adapter.search, 'function');
      if (adapter.fetchById !== undefined) assert.equal(typeof adapter.fetchById, 'function');
      if (adapter.fetchByIsbn !== undefined) assert.equal(typeof adapter.fetchByIsbn, 'function');
      if (adapter.fetchByDoi !== undefined) assert.equal(typeof adapter.fetchByDoi, 'function');
      if (adapter.verify !== undefined) assert.equal(typeof adapter.verify, 'function');
      if (adapter.enrichDoi !== undefined) assert.equal(typeof adapter.enrichDoi, 'function');
      if (adapter.lookup !== undefined) assert.equal(typeof adapter.lookup, 'function');
    });
  }

  it('pubmed matches src with pmid', () => {
    assert.equal(pubmed.matches({ pmid: '12345678' }), true);
    assert.equal(pubmed.matches({ pmid: null }), false);
    assert.equal(pubmed.matches({}), false);
  });

  it('arxiv matches src with arxivId', () => {
    assert.equal(arxiv.matches({ arxivId: '1706.03762' }), true);
    assert.equal(arxiv.matches({ arxivId: null }), false);
  });

  it('rfc matches src with rfcNumber', () => {
    assert.equal(rfc.matches({ rfcNumber: '9110' }), true);
    assert.equal(rfc.matches({ rfcNumber: null }), false);
  });

  it('openlibrary matches src with isbn', () => {
    assert.equal(openlibrary.matches({ isbn: '9780143127796' }), true);
    assert.equal(openlibrary.matches({ isbn: null }), false);
  });

  it('crossref matches src with doi', () => {
    assert.equal(crossref.matches({ doi: '10.1234/test' }), true);
    assert.equal(crossref.matches({ doi: null }), false);
  });

  it('pmc matches src with pmc', () => {
    assert.equal(pmc.matches({ pmc: 'PMC1234567' }), true);
    assert.equal(pmc.matches({ pmc: null }), false);
  });
});
