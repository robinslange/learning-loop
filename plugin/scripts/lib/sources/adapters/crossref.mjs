import { fetchJSON } from '../http.mjs';
import { inferSpecies, inferSampleSize } from '../heuristics.mjs';
import { authorMatches, firstAuthorMatches } from '../author-match.mjs';
import biorxiv from './biorxiv.mjs';

async function search(query, rows = 5) {
  const url = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(query)}&rows=${rows}&select=DOI,title,author,published-print,published-online,container-title,abstract,type`;
  const data = await fetchJSON(url);
  if (!data?.message?.items) return [];
  return data.message.items.map((item) => {
    const authors = (item.author || []).map((a) => `${a.family || ''} ${a.given || ''}`.trim());
    const dateArr =
      item['published-print']?.['date-parts']?.[0] || item['published-online']?.['date-parts']?.[0];
    const year = dateArr?.[0] || null;
    const abstractRaw = item.abstract || '';
    const abstractClean = abstractRaw.replace(/<[^>]+>/g, '');
    return {
      source: 'crossref',
      pmid: null,
      pmc: null,
      doi: item.DOI,
      title: item.title?.[0] || null,
      authors,
      firstAuthor: authors[0] || null,
      year,
      journal: item['container-title']?.[0] || null,
      abstract: abstractClean || null,
      studyType: item.type || null,
      species: inferSpecies(abstractClean.toLowerCase(), (item.title?.[0] || '').toLowerCase()),
      sampleSize: inferSampleSize(abstractClean.toLowerCase()),
      funding: [],
      coiStatement: null,
      url: `https://doi.org/${item.DOI}`,
    };
  });
}

async function verifyDoi(doi, claimedAuthor, claimedYear) {
  const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
  const data = await fetchJSON(url);
  if (!data?.message) {
    if (doi.startsWith('10.1101/')) {
      const biorxivData = await biorxiv.fetchByDoi(doi);
      if (biorxivData) {
        const issues = [];
        if (
          claimedAuthor &&
          biorxivData.authors.length > 0 &&
          !authorMatches(claimedAuthor, biorxivData.authors)
        ) {
          issues.push({
            type: 'wrong_author',
            severity: 'high',
            claimed: claimedAuthor,
            actual_first: biorxivData.firstAuthor,
          });
        }
        if (claimedYear && biorxivData.year && Math.abs(claimedYear - biorxivData.year) > 1) {
          issues.push({
            type: 'wrong_year',
            severity: 'high',
            claimed: claimedYear,
            actual: biorxivData.year,
          });
        }
        return { verified: issues.length === 0, issues, metadata: biorxivData };
      }
    }
    return { verified: false, error: 'DOI not found', doi };
  }

  const item = data.message;
  const authors = (item.author || []).map((a) => `${a.family || ''} ${a.given || ''}`.trim());
  const dateArr =
    item['published-print']?.['date-parts']?.[0] || item['published-online']?.['date-parts']?.[0];
  const year = dateArr?.[0] || null;

  const issues = [];

  if (claimedAuthor) {
    if (!authors || authors.length === 0) {
      issues.push({
        type: 'unverifiable_author',
        severity: 'low',
        claimed: claimedAuthor,
        reason: 'no author metadata returned from API',
      });
    } else if (!firstAuthorMatches(claimedAuthor, authors)) {
      if (!authorMatches(claimedAuthor, authors)) {
        issues.push({
          type: 'wrong_author',
          severity: 'high',
          claimed: claimedAuthor,
          actual_first: authors[0],
          actual_all: authors,
        });
      } else {
        issues.push({
          type: 'author_not_first',
          severity: 'medium',
          claimed: claimedAuthor,
          actual_first: authors[0],
        });
      }
    }
  }

  if (claimedYear && year && Math.abs(claimedYear - year) > 1) {
    issues.push({ type: 'wrong_year', severity: 'high', claimed: claimedYear, actual: year });
  }

  return {
    verified: issues.length === 0,
    issues,
    metadata: {
      source: 'crossref',
      doi,
      title: item.title?.[0],
      authors,
      firstAuthor: authors[0],
      year,
      journal: item['container-title']?.[0],
      url: `https://doi.org/${doi}`,
    },
  };
}

function matches(src) {
  return !!src.doi;
}

async function verify(src) {
  return verifyDoi(src.doi, src.claimedAuthor, src.claimedYear);
}

export { verifyDoi };
export default { id: 'crossref', matches, search, verify };
