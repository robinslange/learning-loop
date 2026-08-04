// tests/sources/author-match.test.mjs — the author check README stakes its
// headline on ("catches a misattributed author on a real PMID"), and which
// every adapter routes through. It shipped untested.
//
// The original predicate matched on bidirectional substring containment over
// tokens filtered by RAW length, so `R.` survived as the one-letter token `r`
// and `authorMatches('Roberts', ['R. Fielding, Ed.'])` was true. A fabricated
// author passed whenever the real list contained any substring of it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  authorMatches,
  firstAuthorMatches,
  extractSurnames,
  bestAuthorMatch,
} from '../../plugin/scripts/lib/sources/author-match.mjs';

describe('extractSurnames', () => {
  it('drops initials, because a one-letter token matches almost anything', () => {
    assert.deepEqual(extractSurnames('R. Fielding, Ed.'), ['fielding']);
  });

  // The initial filter cuts at ONE character. Cutting at two also removes
  // Wu / Li / Ng / Xu / Ho / Yu, leaving nothing to match on, which reports
  // every citation by such an author as a WRONG author.
  it('keeps two-letter surnames', () => {
    // A two-letter initial pair (`KL`) survives the filter. That is harmless:
    // whole-token equality means it can only ever match a literal `kl`.
    assert.deepEqual(extractSurnames('Wu J'), ['wu']);
    assert.ok(extractSurnames('Ng KL').includes('ng'));
    for (const [claimed, actual] of [
      ['Wu', ['Wu J']],
      ['Ng', ['Ng KL']],
      ['Li', ['Li X', 'Zhang Y']],
      ['Xu', ['Xu H']],
      ['Ho', ['Ho CS']],
      ['Yu', ['Yu M']],
    ]) {
      assert.equal(authorMatches(claimed, actual), true, `${claimed} must match ${actual[0]}`);
    }
  });

  it('drops editorial and particle tokens that carry no identity', () => {
    assert.deepEqual(extractSurnames('Smith et al.'), ['smith']);
    assert.deepEqual(extractSurnames('van der Berg'), ['berg']);
    assert.deepEqual(extractSurnames('Doe Jr.'), ['doe']);
  });

  it('folds diacritics and splits hyphenated surnames', () => {
    assert.deepEqual(extractSurnames('Müller'), ['muller']);
    assert.deepEqual(extractSurnames('Smith-Jones'), ['smith', 'jones']);
  });
});

describe('authorMatches rejects fabrications', () => {
  const fabricated = [
    ['Roberts', ['R. Fielding, Ed.', 'M. Nottingham, Ed.', 'J. Reschke, Ed.']],
    ['Jackson', ['Smith JA']],
    ['Smith et al.', ['Smithers John']],
    ['Zzzyx', ['R. Fielding, Ed.']],
    ['Van Halen', ['Van Morrison']],
    ['Anderson', ['A. Andersen']],
  ];

  for (const [claimed, actual] of fabricated) {
    it(`"${claimed}" does not match ${JSON.stringify(actual)}`, () => {
      assert.equal(authorMatches(claimed, actual), false);
    });
  }
});

describe('authorMatches accepts genuine attributions', () => {
  const genuine = [
    ['Fielding', ['R. Fielding, Ed.']],
    ['Nottingham', ['R. Fielding, Ed.', 'M. Nottingham, Ed.']],
    ['Smith JA', ['Smith JA']],
    ['Muller', ['Müller H']],
    ['Smith-Jones', ['Smith-Jones A']],
    ['Smith', ['Smith-Jones A']],
    ["O'Brien", ["O'Brien P"]],
    ['van der Berg', ['Van Der Berg K']],
    ['Cepeda et al.', ['Cepeda NJ', 'Vul E', 'Rohrer D']],
  ];

  for (const [claimed, actual] of genuine) {
    it(`"${claimed}" matches ${JSON.stringify(actual)}`, () => {
      assert.equal(authorMatches(claimed, actual), true);
    });
  }
});

describe('firstAuthorMatches', () => {
  it('only consults the first author', () => {
    assert.equal(firstAuthorMatches('Cepeda', ['Cepeda NJ', 'Vul E']), true);
    assert.equal(firstAuthorMatches('Vul', ['Cepeda NJ', 'Vul E']), false);
  });

  it('is false on an empty author list rather than throwing', () => {
    assert.equal(firstAuthorMatches('Cepeda', []), false);
    assert.equal(firstAuthorMatches('Cepeda', null), false);
  });
});

describe('bestAuthorMatch', () => {
  const candidates = [
    { id: 'a', authors: ['Smith JA'] },
    { id: 'b', authors: ['Cepeda NJ'] },
  ];

  it('picks the candidate whose author list matches the claim', () => {
    assert.equal(bestAuthorMatch(candidates, 'Cepeda').id, 'b');
  });

  it('returns null rather than a wrong paper when nothing matches', () => {
    assert.equal(bestAuthorMatch(candidates, 'Roberts'), null);
  });

  it('falls back to the first candidate when no author was claimed', () => {
    assert.equal(bestAuthorMatch(candidates, null).id, 'a');
  });
});
