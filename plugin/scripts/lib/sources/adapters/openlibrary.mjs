import { fetchJSON } from '../http.mjs';
import { authorMatches } from '../author-match.mjs';

async function fetchByIsbn(isbn) {
  const cleanIsbn = isbn.replace(/[-\s]/g, '');
  const url = `https://openlibrary.org/api/books?bibkeys=ISBN:${cleanIsbn}&format=json&jscmd=data`;
  const data = await fetchJSON(url);
  if (!data) return null;
  const entry = data[`ISBN:${cleanIsbn}`];
  if (!entry) return null;
  const authors = (entry.authors || []).map((a) => a.name);
  return {
    source: 'openlibrary',
    pmid: null,
    pmc: null,
    doi: null,
    isbn: cleanIsbn,
    title: entry.title,
    subtitle: entry.subtitle || null,
    authors,
    firstAuthor: authors[0] || null,
    year: entry.publish_date ? parseInt(entry.publish_date.match(/\d{4}/)?.[0]) : null,
    journal: null,
    publisher: (entry.publishers || [])[0]?.name || null,
    pages: entry.number_of_pages || null,
    abstract: null,
    studyType: 'book',
    species: null,
    sampleSize: null,
    funding: [],
    coiStatement: null,
    url: entry.url,
  };
}

function matches(src) {
  return !!src.isbn;
}

async function verify(src) {
  const data = await fetchByIsbn(src.isbn);
  if (!data) {
    return { verified: false, error: `ISBN ${src.isbn} not found in Open Library`, metadata: null };
  }
  const issues = [];
  // A missing author list is not a passing author check. Gating the comparison
  // on `authors.length > 0` meant an API that returned no authors verified the
  // citation clean, which is the one case where nothing was actually checked.
  if (src.claimedAuthor && data.authors.length === 0) {
    issues.push({
      type: 'unverifiable_author',
      severity: 'low',
      claimed: src.claimedAuthor,
      reason: 'no author metadata returned by the source',
    });
  } else if (
    src.claimedAuthor &&
    data.authors.length > 0 &&
    !authorMatches(src.claimedAuthor, data.authors)
  ) {
    issues.push({
      type: 'wrong_author',
      severity: 'high',
      claimed: src.claimedAuthor,
      actual_first: data.firstAuthor,
    });
  }
  return { verified: issues.length === 0, issues, metadata: data };
}

export default { id: 'openlibrary', capabilities: ['verify'], matches, fetchByIsbn, verify };
