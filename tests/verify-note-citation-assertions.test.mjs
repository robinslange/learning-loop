// tests/verify-note-citation-assertions.test.mjs — a resolver with no way to
// abstain turns a loose citation into a wrong one.
//
// verify-note's bare author-year branch searched `<author> <year> <topic>`,
// took the first hit, and accepted it whenever the claimed surname appeared
// ANYWHERE in the resolved author list. The claimed year was spent building the
// query and then discarded. Observed on real vault notes, all `verified: true`
// with an empty issues array, so the promotion gate counted zero problems:
//
//   "Rogers 2014"          -> Mitzner 2016, older adults' perceptions of computers
//                             (matched author 2 "Rogers Wendy A"; year off by two)
//   "James & Rogers 2005"  -> Chan 2005, paediatric cochlear implantation
//                             (matched author 3 "James Adrian L"; no Rogers at all)
//   "Haskell et al. 2005"  -> Taylor-Piliae 2006, Tai Chi hemodynamics
//                             (matched author 2 "Haskell William L"; year off by one)
//
// Meanwhile the notes' properly-formed URL citations returned verified:false.
// The tool was inverted: real citations failed, loose ones passed.
//
// The fix checks exactly what each citation form asserts and nothing more:
//   "X et al."  asserts X is the FIRST author
//   "X & Y"     asserts X and Y are BOTH authors
//   "X"         asserts X is an author
//   the year    asserts the publication year
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { citationAssertionIssues } from '../plugin/scripts/verify/citation-assertions.mjs';

const high = (issues) => issues.filter((i) => i.severity === 'high');

describe('the year a citation states is an assertion, not a search term', () => {
  test('a two-year gap is a wrong paper, not a publication lag', () => {
    // "Rogers 2014" resolved to a 2016 paper.
    const issues = citationAssertionIssues('Rogers', 2014, {
      year: 2016,
      authors: ['Mitzner Tracy L', 'Rogers Wendy A', 'Fisk Arthur D'],
    });
    const wrongYear = issues.find((i) => i.type === 'wrong_year');
    assert.ok(wrongYear, 'a 2014 claim resolving to 2016 must raise wrong_year');
    assert.equal(wrongYear.severity, 'high');
    assert.equal(wrongYear.claimed, 2014);
    assert.equal(wrongYear.actual, 2016);
  });

  test('an off-by-one year is online-first lag and must not demote', () => {
    const issues = citationAssertionIssues('Schuurman', 2015, {
      year: 2016,
      authors: ['Schuurman Noemi K'],
    });
    const offByOne = issues.find((i) => i.type === 'year_off_by_one');
    assert.ok(offByOne, 'a one-year gap is real and common; flag it without demoting');
    assert.equal(offByOne.severity, 'low');
    assert.equal(high(issues).length, 0);
  });

  test('an exact year match raises nothing', () => {
    const issues = citationAssertionIssues('Schuurman', 2015, {
      year: 2015,
      authors: ['Schuurman Noemi K'],
    });
    assert.equal(issues.length, 0);
  });

  test('a resolver returning no year cannot contradict the claim', () => {
    const issues = citationAssertionIssues('Schuurman', 2015, {
      year: null,
      authors: ['Schuurman Noemi K'],
    });
    assert.equal(
      issues.filter((i) => i.type.startsWith('year') || i.type === 'wrong_year').length,
      0,
    );
  });
});

describe('"et al." asserts first authorship', () => {
  test('a match at author position 2 does not satisfy "et al."', () => {
    // "Haskell et al. 2005" resolved to Taylor-Piliae 2006.
    const issues = citationAssertionIssues('Haskell et al.', 2005, {
      year: 2006,
      authors: ['Taylor-Piliae Ruth E', 'Haskell William L', 'Froelicher Erika Sivarajan'],
    });
    const wrongFirst = issues.find((i) => i.type === 'wrong_first_author');
    assert.ok(wrongFirst, '"et al." names the first author; position 2 is a different paper');
    assert.equal(wrongFirst.severity, 'high');
    assert.equal(wrongFirst.actual_first, 'Taylor-Piliae Ruth E');
  });

  test('a genuine first-author match with the right year is clean', () => {
    const issues = citationAssertionIssues('Haqiqatkhah et al.', 2025, {
      year: 2025,
      authors: ['Haqiqatkhah Mohammadhossein Manuel', 'Hamaker Ellen L'],
    });
    assert.equal(issues.length, 0);
  });
});

describe('"X & Y" asserts both are authors', () => {
  test('an absent co-author is a wrong paper', () => {
    // "James & Rogers 2005" resolved to Chan 2005 — James present, Rogers absent.
    const issues = citationAssertionIssues('James & Rogers', 2005, {
      year: 2005,
      authors: ['Chan Yvonne', 'Campisi Paolo', 'James Adrian L', 'Papsin Blake C'],
    });
    const missing = issues.find((i) => i.type === 'missing_claimed_author');
    assert.ok(missing, 'Rogers is claimed as a co-author and is not on the paper');
    assert.equal(missing.severity, 'high');
    assert.equal(missing.claimed, 'Rogers');
  });

  test('a short form naming authors 2 and 3 is still the right paper', () => {
    // "Houtveen & Hamaker 2015" is a loose short form of Schuurman, Houtveen &
    // Hamaker 2015. Both claimed authors are on it, so nothing is contradicted.
    // "&" asserts co-authorship, NOT position — flagging this would demote a
    // correctly-sourced note for a citation style choice.
    const issues = citationAssertionIssues('Houtveen & Hamaker', 2015, {
      year: 2015,
      authors: ['Schuurman Noemi K', 'Houtveen Jan H', 'Hamaker Ellen L'],
    });
    assert.equal(issues.length, 0);
  });

  test('both authors absent is still one issue per absent author', () => {
    // "Wilson & Hutcherson 2024" resolved to Eberl 2026, dairy barn bedding.
    const issues = citationAssertionIssues('Wilson & Hutcherson', 2024, {
      year: 2026,
      authors: ['Eberl Daniela T', 'Klein Marion'],
    });
    assert.equal(high(issues).filter((i) => i.type === 'missing_claimed_author').length, 2);
    assert.ok(high(issues).some((i) => i.type === 'wrong_year'));
  });
});

describe('a bare surname asserts authorship only', () => {
  test('a last-author match satisfies a bare surname', () => {
    // Senior authors are conventionally cited last; a bare "Hamaker 2015"
    // asserts nothing about position.
    const issues = citationAssertionIssues('Hamaker', 2015, {
      year: 2015,
      authors: ['Schuurman Noemi K', 'Houtveen Jan H', 'Hamaker Ellen L'],
    });
    assert.equal(issues.length, 0);
  });

  test('a surname absent from the author list is a wrong paper', () => {
    const issues = citationAssertionIssues('Rogers', 2014, {
      year: 2014,
      authors: ['Mitzner Tracy L', 'Fisk Arthur D'],
    });
    const wrong = issues.find((i) => i.type === 'wrong_author');
    assert.ok(wrong, 'no claimed surname on the paper at all');
    assert.equal(wrong.severity, 'high');
  });

  test('a resolver returning no authors cannot confirm or contradict', () => {
    const issues = citationAssertionIssues('Rogers', 2014, { year: 2014, authors: [] });
    const unverifiable = issues.find((i) => i.type === 'unverifiable_author');
    assert.ok(unverifiable);
    assert.equal(unverifiable.severity, 'low');
    assert.equal(high(issues).length, 0);
  });
});
