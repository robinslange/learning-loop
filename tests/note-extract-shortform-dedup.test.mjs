// tests/note-extract-shortform-dedup.test.mjs — a short-form mention of a work
// the note already cites with an identifier is not an independent claim.
//
// The link-text author/year regex required the year to follow the author
// directly, so `Rogers, "Caffeine and Alertness" (2014)` parsed as author:null.
// The dedup below it matches on author+year, so it could not tell that a later
// bare "Rogers 2014" referred to that same, already-verified source. The bare
// mention was then resolved independently by search — and search always returns
// something. Once bare mentions are graded (citation-assertions.mjs), failing to
// dedup them would demote correctly-sourced notes for citing themselves twice.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractSourcesFromNote } from '../plugin/scripts/lib/sources/note-extract.mjs';

const NOTE = [
  '# Caffeine',
  '',
  'The defence is in [Rogers, "Caffeine and Alertness: In Defense of Withdrawal Reversal" (2014)](https://journals.sagepub.com/doi/full/10.1089/jcr.2014.0009).',
  'The trial is [Haskell et al., "Cognitive and mood improvements of caffeine" (2005)](https://pubmed.ncbi.nlm.nih.gov/15678363/).',
  '',
  'As Rogers 2014 argued, and as Haskell et al. 2005 measured, the effect is contested.',
  'Meanwhile Wilson 2024 never addressed it.',
].join('\n');

describe('link text yields author and year even when a title sits between them', () => {
  test('parses the author from "Author, \\"Title\\" (Year)"', () => {
    const src = extractSourcesFromNote(NOTE).find((s) => s.doi === '10.1089/jcr.2014.0009');
    assert.equal(src.claimedAuthor, 'Rogers');
    assert.equal(src.claimedYear, 2014);
  });

  test('prefers the parenthesised year over one inside the title', () => {
    const [src] = extractSourcesFromNote(
      '[Smith, "Trends since 1990 in caffeine use" (2014)](https://doi.org/10.1/x)',
    );
    assert.equal(src.claimedYear, 2014);
  });
});

describe('a short form of an already-identified source is not resolved again', () => {
  const bare = () =>
    extractSourcesFromNote(NOTE).filter((s) => !s.pmid && !s.doi && !s.pmc && s.claimedAuthor);

  test('"Rogers 2014" does not become a second, identifier-less source', () => {
    assert.equal(
      bare().some((s) => s.claimedAuthor.includes('Rogers')),
      false,
      'it duplicates the DOI-cited Rogers 2014 already in this note',
    );
  });

  test('"Haskell et al. 2005" does not become a second source', () => {
    assert.equal(
      bare().some((s) => s.claimedAuthor.includes('Haskell')),
      false,
      'it duplicates the PMID-cited Haskell et al. 2005 already in this note',
    );
  });

  test('a genuinely uncited mention is still extracted for checking', () => {
    assert.ok(
      bare().some((s) => s.claimedAuthor.includes('Wilson')),
      'Wilson 2024 has no identifier-bearing citation, so it must still be graded',
    );
  });
});
