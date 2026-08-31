import { fetchJSON } from '../http.mjs';
import { authorMatches } from '../author-match.mjs';

async function fetchById(rfcNumber) {
  const num = String(rfcNumber).replace(/^rfc/i, '');
  const url = `https://www.rfc-editor.org/rfc/rfc${num}.json`;
  const data = await fetchJSON(url);
  if (!data) return null;
  const authors = (data.authors || []).map((a) =>
    typeof a === 'string' ? a : a.name || `${a.given || ''} ${a.family || ''}`.trim(),
  );
  return {
    source: 'rfc',
    pmid: null,
    pmc: null,
    doi: null,
    rfcNumber: parseInt(num),
    title: data.title,
    authors,
    firstAuthor: authors[0] || null,
    year: data.pub_date ? parseInt(data.pub_date.match(/\d{4}/)?.[0]) : null,
    journal: 'IETF RFC',
    abstract: data.abstract || null,
    studyType: 'standard',
    species: null,
    sampleSize: null,
    funding: [],
    coiStatement: null,
    status: data.pub_status || data.status,
    url: `https://www.rfc-editor.org/rfc/rfc${num}`,
  };
}

function matches(src) {
  return !!src.rfcNumber;
}

async function verify(src) {
  const data = await fetchById(src.rfcNumber);
  if (!data) {
    return { verified: false, error: `RFC ${src.rfcNumber} not found`, metadata: null };
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

export default { id: 'rfc', capabilities: ['verify'], matches, fetchById, verify };
