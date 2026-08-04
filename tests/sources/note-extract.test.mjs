import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractSourcesFromNote } from '../../plugin/scripts/lib/sources/note-extract.mjs';
import { findNumberInAbstract } from '../../plugin/scripts/lib/sources/claim-numbers.mjs';

const byId = (sources) =>
  sources.map((s) => [s.pmid || s.pmc || s.doi, s.claimedAuthor, s.claimedYear]);

describe('extractSourcesFromNote author-year attribution', () => {
  // Regression: the author-year was taken as the FIRST match in a fixed 100-char
  // lookback, so a line carrying two citations bound both identifiers to the
  // earliest author on it. Pre-fix this returned Smith for both PMIDs.
  it('binds each identifier to its own nearest author, not the first on the line', () => {
    const note =
      'Smith et al. 2019 found X (PMID 12345678); Jones & Barr 2021 later showed Y (PMID 87654321).';
    assert.deepEqual(byId(extractSourcesFromNote(note)), [
      ['12345678', 'Smith et al.', 2019],
      ['87654321', 'Jones & Barr', 2021],
    ]);
  });

  it('does not reach across a newline into the previous citation', () => {
    const note = [
      'Smith et al. 2019 established the baseline.',
      'PMC 1234567 reports the replication.',
    ].join('\n');
    const pmc = extractSourcesFromNote(note).find((s) => s.pmc);
    assert.equal(pmc.claimedAuthor, null, 'a citation on its own line must not claim the line above');
  });

  it('leaves author-year unset when no citation precedes the identifier', () => {
    const [only] = extractSourcesFromNote('See PMID 11112222 for details.');
    assert.equal(only.pmid, '11112222');
    assert.equal(only.claimedAuthor, null);
    assert.equal(only.claimedYear, null);
  });
});

describe('inline PMID extraction', () => {
  const pmids = (s) => extractSourcesFromNote(s).map((x) => x.pmid).filter(Boolean);

  it('accepts the colon form, which is at least as common as the bare space', () => {
    assert.deepEqual(pmids('Jones 2020 (PMID: 12345678).'), ['12345678']);
    assert.deepEqual(pmids('Jones 2020 (PMID:12345678).'), ['12345678']);
    assert.deepEqual(pmids('Jones 2020 (PMID 12345678).'), ['12345678']);
    assert.deepEqual(pmids('Jones 2020 (PubMed 1234567).'), ['1234567']);
  });

  it('does not truncate a longer digit run into a different real article', () => {
    // Without a trailing-digit guard this yielded '12345678' — a genuine but
    // unrelated PMID, which then verified clean. A fabricated identifier that
    // resolves to a real paper is worse than one that 404s.
    assert.deepEqual(pmids('Jones 2020 (PMID 123456789012).'), []);
  });
});

describe('findNumberInAbstract digit boundaries', () => {
  it('does not match a claim as a substring of a longer number', () => {
    assert.equal(findNumberInAbstract('5', 'the rate was 45.2 percent').found, false);
    assert.equal(findNumberInAbstract('12', 'we enrolled 120 patients').found, false);
    assert.equal(findNumberInAbstract('2', 'a 32-fold increase').found, false);
  });

  it('still matches the number the abstract actually states', () => {
    assert.equal(findNumberInAbstract('45.2', 'the rate was 45.2 percent').found, true);
    assert.equal(findNumberInAbstract('120', 'we enrolled 120 patients').found, true);
    assert.equal(findNumberInAbstract('5', 'exactly 5 patients').found, true);
  });
});
