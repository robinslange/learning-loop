import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceIdFromUrl } from '../plugin/scripts/librarian/research/source-id.mjs';

test('parses a PMID from a pubmed URL', () => {
  assert.deepEqual(sourceIdFromUrl('https://pubmed.ncbi.nlm.nih.gov/39070254/'), {
    kind: 'pmid',
    id: '39070254',
    author: null,
    year: null,
  });
});

test('parses a DOI from a doi.org URL', () => {
  assert.deepEqual(sourceIdFromUrl('https://doi.org/10.3390/nu16111192'), {
    kind: 'doi',
    id: '10.3390/nu16111192',
    author: null,
    year: null,
  });
});

test('parses a DOI from a publisher /doi/ path', () => {
  const r = sourceIdFromUrl('https://www.mdpi.com/doi/full/10.3390/nu16081192');
  assert.equal(r.kind, 'doi');
  assert.equal(r.id, '10.3390/nu16081192');
});

test('strips a Wiley legacy /full path suffix from the DOI', () => {
  const r = sourceIdFromUrl('https://onlinelibrary.wiley.com/doi/10.1002/hep.31884/full');
  assert.equal(r.kind, 'doi');
  assert.equal(r.id, '10.1002/hep.31884');
});

test('strips /abstract, /pdf, /epdf, /references DOI path suffixes', () => {
  for (const suffix of ['abstract', 'pdf', 'epdf', 'references']) {
    const r = sourceIdFromUrl(`https://onlinelibrary.wiley.com/doi/10.1002/hep.31884/${suffix}`);
    assert.equal(r.id, '10.1002/hep.31884', `suffix /${suffix}`);
  }
});

test('does not over-strip a DOI whose own path contains slashes', () => {
  const r = sourceIdFromUrl('https://doi.org/10.1016/j.cell.2020.01.001');
  assert.equal(r.id, '10.1016/j.cell.2020.01.001');
});

test('parses an arXiv id, stripping the version suffix', () => {
  assert.deepEqual(sourceIdFromUrl('https://arxiv.org/abs/2310.06825v2'), {
    kind: 'arxiv',
    id: '2310.06825',
    author: null,
    year: null,
  });
});

test('returns null for a PMC URL (not a PMID id space — must not be verified as a pmid)', () => {
  assert.equal(sourceIdFromUrl('https://pmc.ncbi.nlm.nih.gov/articles/PMC11275561/'), null);
});

test('returns null for a plain web URL with no identifier', () => {
  assert.equal(sourceIdFromUrl('https://www.frontiersin.org/journals/nutrition/articles'), null);
});

test('returns null for empty or non-string input', () => {
  assert.equal(sourceIdFromUrl(''), null);
  assert.equal(sourceIdFromUrl(null), null);
  assert.equal(sourceIdFromUrl(undefined), null);
});
