// tests/verify-note-bare-citation-integration.test.mjs — the grading in
// citation-assertions.mjs only protects anything if verifyNote actually applies
// it to the bare author-year branch.
//
// This drives the real regression end to end with PubMed mocked at the network: the
// note says "Haskell et al. 2005", the resolver returns Taylor-Piliae 2006 (a
// real paper with a real Haskell at author position 2, which is exactly why the
// old any-position check accepted it). The promotion gate counts
// issues[].severity === 'high', so that is what this asserts on.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyNote } from '../plugin/scripts/verify/verify-note.mjs';
import { HttpResponse, http, startMockNetwork } from './helpers/msw.mjs';

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const server = startMockNetwork();

function efetchXml({ pmid, title, year, authors }) {
  const authorXml = authors
    .map(
      ([last, fore]) => `<Author><LastName>${last}</LastName><ForeName>${fore}</ForeName></Author>`,
    )
    .join('');
  return `<PubmedArticleSet><PubmedArticle><MedlineCitation><Article>
    <ArticleTitle>${title}</ArticleTitle>
    <AuthorList>${authorXml}</AuthorList>
    <Journal><PubDate><Year>${year}</Year></PubDate></Journal>
  </Article></MedlineCitation><PubmedData><ArticleIdList>
    <ArticleId IdType="pubmed">${pmid}</ArticleId>
  </ArticleIdList></PubmedData></PubmedArticle></PubmedArticleSet>`;
}

// The paper the resolver really returned for "Haskell et al. 2005".
const TAI_CHI = {
  pmid: '16785338',
  title: 'Hemodynamic responses to a community-based Tai Chi exercise intervention',
  year: 2006,
  authors: [
    ['Taylor-Piliae', 'Ruth E'],
    ['Haskell', 'William L'],
    ['Froelicher', 'Erika Sivarajan'],
  ],
};

function stubPubmed(record) {
  server.use(
    http.get(`${EUTILS}/esearch.fcgi`, () =>
      HttpResponse.json({ esearchresult: { idlist: [record.pmid] } }),
    ),
    http.get(`${EUTILS}/efetch.fcgi`, () => HttpResponse.xml(efetchXml(record))),
  );
}

const highSeverity = (result) =>
  (result.sources || []).flatMap((s) => s.issues || []).filter((i) => i.severity === 'high');

describe('verifyNote grades a bare author-year mention by what it asserts', () => {
  let originalPluginData;
  let dir;

  beforeEach(() => {
    originalPluginData = process.env.CLAUDE_PLUGIN_DATA;
    dir = mkdtempSync(join(tmpdir(), 'll-bare-citation-'));
    process.env.CLAUDE_PLUGIN_DATA = join(dir, 'plugin-data');
  });

  afterEach(() => {
    if (originalPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = originalPluginData;
    rmSync(dir, { recursive: true, force: true });
  });

  function noteWith(body) {
    const p = join(dir, 'note.md');
    writeFileSync(
      p,
      [
        '---',
        'tags: [x]',
        'date: 2026-09-07',
        'source: literature',
        '---',
        '# A claim',
        '',
        body,
      ].join('\n'),
    );
    return p;
  }

  test('"et al." resolving to a paper that lists the author second is not verified', async () => {
    stubPubmed(TAI_CHI);
    const result = await verifyNote(noteWith('Haskell et al. 2005 reported the effect.'));

    const src = result.sources.find((s) => s.source.claimedAuthor?.includes('Haskell'));
    assert.ok(src, 'the bare mention should be extracted as a source');
    assert.equal(src.verified, false, 'a wrong-paper resolution must not read as verified');
    assert.ok(
      src.issues.some((i) => i.type === 'wrong_first_author' && i.severity === 'high'),
      `expected wrong_first_author, got ${JSON.stringify(src.issues)}`,
    );
    assert.ok(highSeverity(result).length > 0, 'the promotion gate must see this and demote');
  });

  test('a correct first-author match with the right year still verifies', async () => {
    stubPubmed({
      pmid: '40388125',
      title: 'Daily dynamics and weekly rhythms',
      year: 2025,
      authors: [
        ['Haqiqatkhah', 'Mohammadhossein Manuel'],
        ['Hamaker', 'Ellen L'],
      ],
    });
    const result = await verifyNote(noteWith('Haqiqatkhah et al. 2025 ran the tutorial.'));

    const src = result.sources.find((s) => s.source.claimedAuthor?.includes('Haqiqatkhah'));
    assert.ok(src, 'the bare mention should be extracted as a source');
    assert.equal(src.verified, true, 'a genuine match must still pass');
    assert.equal(highSeverity(result).length, 0, 'a good citation must not be demoted');
  });

  // Widening link-text author/year parsing (so short forms can be deduped
  // against the citation they repeat) pushed URL-bearing sources into the
  // author-year SEARCH branch. A book on NCBI Bookshelf cited as
  // `Institute of Medicine (US), "Caffeine..." (2001)` then parsed as author
  // "Institute", and PubMed returned a 2001 paper listing "Institute O R"
  // (Oregon Research Institute) among its authors — verified: true, on a
  // lexical-personality paper. Searching for a work by author and year is not
  // verification of the URL the note actually cited.
  test('a URL with no extractable identifier is unverifiable, never search-resolved', async () => {
    let searched = false;
    server.use(
      http.get(`${EUTILS}/esearch.fcgi`, () => {
        searched = true;
        return HttpResponse.json({ esearchresult: { idlist: [] } });
      }),
    );
    const result = await verifyNote(
      noteWith(
        'See [Institute of Medicine (US), "Caffeine" (2001)](https://www.ncbi.nlm.nih.gov/books/NBK223791/).',
      ),
    );

    const src = result.sources.find((s) => s.source.url?.includes('NBK223791'));
    assert.ok(src, 'the link should still be extracted as a source');
    assert.equal(searched, false, 'a cited URL must not be re-resolved by author-year search');
    assert.equal(src.verified, false);
    assert.equal(src.issues[0].type, 'unverifiable_source');
    assert.equal(src.issues[0].severity, 'low', 'a book link must not demote the note');
    assert.equal(highSeverity(result).length, 0);
  });
});
