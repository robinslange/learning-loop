// tests/note-extract-doi-urls.test.mjs — a DOI in a publisher URL is a DOI.
//
// extractSourcesFromNote only recognised the `doi.org/` form, so a citation
// linked as `journals.sagepub.com/doi/full/10.1089/jcr.2014.0009` carried no
// identifier and verify-note reported "No identifiable source information".
// The same note's loose "Rogers 2014" mention meanwhile resolved to an
// unrelated paper and passed. The tool was inverted: correct citations failed
// while sloppy ones verified.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractSourcesFromNote } from '../plugin/scripts/lib/sources/note-extract.mjs';

const doiOf = (md) => extractSourcesFromNote(md).find((s) => s.doi)?.doi;

describe('DOIs are extracted from publisher URLs, not only doi.org', () => {
  test('extracts a DOI from a SagePub /doi/full/ URL', () => {
    assert.equal(
      doiOf('[Rogers (2014)](https://journals.sagepub.com/doi/full/10.1089/jcr.2014.0009)'),
      '10.1089/jcr.2014.0009',
    );
  });

  test('extracts a DOI from a Wiley /doi/abs/ URL', () => {
    assert.equal(
      doiOf('[Someone (2019)](https://onlinelibrary.wiley.com/doi/abs/10.1111/jopy.12456)'),
      '10.1111/jopy.12456',
    );
  });

  test('still extracts the plain doi.org form', () => {
    assert.equal(doiOf('[Smith (2020)](https://doi.org/10.1000/xyz123)'), '10.1000/xyz123');
  });

  test('stops at a query string rather than swallowing it into the DOI', () => {
    assert.equal(
      doiOf('[Paper](https://publisher.example/doi/10.1234/abc.def?utm_source=x)'),
      '10.1234/abc.def',
    );
  });

  test('does not invent a DOI from a URL that has none', () => {
    assert.equal(doiOf('[Bookshelf](https://www.ncbi.nlm.nih.gov/books/NBK223791/)'), undefined);
  });
});
