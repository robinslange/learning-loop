import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractAuthorYearCitations } from '../plugin/scripts/lib/cite-extract.mjs';

// Drives the real vendored winkNLP model (no mock — it is an in-process pure
// dependency we test through). Pins the citation-extraction contract.

test('extracts a simple Author Year citation', () => {
  assert.deepEqual(extractAuthorYearCitations('As Smith 2020 showed, this holds.'), [
    { author: 'Smith', year: 2020 },
  ]);
});

test('joins multi-author citations with & / and', () => {
  assert.deepEqual(extractAuthorYearCitations('Per Smith & Jones 2019.'), [
    { author: 'Smith & Jones', year: 2019 },
  ]);
});

test('recognises the "et al." pattern', () => {
  assert.deepEqual(extractAuthorYearCitations('Cormack et al. 2009 introduced RRF.'), [
    { author: 'Cormack et al.', year: 2009 },
  ]);
});

test('rejects a month as an author (NOT_AUTHORS filter)', () => {
  assert.deepEqual(extractAuthorYearCitations('In March 2020 the study ran.'), []);
  assert.deepEqual(extractAuthorYearCitations('Published December 2018.'), []);
});

test('rejects a year outside the plausible range (YEAR_RE)', () => {
  // 1812 is before the 1950 floor; 2099 is after the 2039 ceiling.
  assert.deepEqual(extractAuthorYearCitations('Napoleon 1812 lost.'), []);
  assert.deepEqual(extractAuthorYearCitations('Author 2099 wrote.'), []);
});

test('accepts the YEAR_RE range boundaries', () => {
  assert.deepEqual(extractAuthorYearCitations('Author 1950 wrote.'), [
    { author: 'Author', year: 1950 },
  ]);
  assert.deepEqual(extractAuthorYearCitations('Author 2039 wrote.'), [
    { author: 'Author', year: 2039 },
  ]);
});

test('rejects a lone initial as an author', () => {
  assert.deepEqual(extractAuthorYearCitations('L. 2020 is not an author.'), []);
});

test('skips author initials between the name and the year', () => {
  // The initial-skip loop before the year must not break the match.
  assert.deepEqual(extractAuthorYearCitations('Smith A. 2020 wrote.'), [
    { author: 'Smith', year: 2020 },
  ]);
  assert.deepEqual(extractAuthorYearCitations('Smith A. C. 2020 wrote.'), [
    { author: 'Smith', year: 2020 },
  ]);
});

test('skips comma/parenthesis punctuation between author and year', () => {
  assert.deepEqual(extractAuthorYearCitations('Smith, 2020 wrote.'), [
    { author: 'Smith', year: 2020 },
  ]);
  assert.deepEqual(extractAuthorYearCitations('This holds (Smith 2020).'), [
    { author: 'Smith', year: 2020 },
  ]);
});

test('deduplicates repeated identical citations', () => {
  const out = extractAuthorYearCitations('Smith 2020 and again Smith 2020 later.');
  assert.deepEqual(out, [{ author: 'Smith', year: 2020 }]);
});

test('skips blank lines and text with no citations', () => {
  assert.deepEqual(extractAuthorYearCitations('\n\njust some prose here\n\n'), []);
  assert.deepEqual(extractAuthorYearCitations(''), []);
});

test('finds citations across multiple lines', () => {
  const out = extractAuthorYearCitations('Smith 2020 said one thing.\nJones 2018 said another.');
  assert.deepEqual(
    out.sort((a, b) => a.year - b.year),
    [
      { author: 'Jones', year: 2018 },
      { author: 'Smith', year: 2020 },
    ],
  );
});
