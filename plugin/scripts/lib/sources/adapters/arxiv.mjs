import { fetchXML, sleep, RATE_LIMIT_MS } from '../http.mjs';
import { parseXMLTag, parseXMLTags } from '../xml.mjs';
import { authorMatches } from '../author-match.mjs';

export function parseArxivEntry(entryXml) {
  const title = parseXMLTag(entryXml, 'title')?.replace(/\s+/g, ' ');
  const abstract = parseXMLTag(entryXml, 'summary')?.replace(/\s+/g, ' ');
  const published = parseXMLTag(entryXml, 'published');
  const year = published ? parseInt(published.substring(0, 4)) : null;

  const authorRe = /<author>\s*<name>([^<]+)<\/name>/g;
  const authors = [];
  let am;
  while ((am = authorRe.exec(entryXml)) !== null) authors.push(am[1].trim());

  const idTag = parseXMLTag(entryXml, 'id');
  const arxivId = idTag?.match(/abs\/(.+)/)?.[1]?.replace(/v\d+$/, '') || null;

  const categoryRe = /category\s+term="([^"]+)"/g;
  const categories = [];
  let cm;
  while ((cm = categoryRe.exec(entryXml)) !== null) categories.push(cm[1]);

  const doiTag = entryXml.match(/<arxiv:doi[^>]*>([^<]+)<\/arxiv:doi>/)?.[1] || null;

  return {
    source: 'arxiv',
    pmid: null,
    pmc: null,
    doi: doiTag,
    arxivId,
    title,
    authors,
    firstAuthor: authors[0] || null,
    year,
    journal: null,
    abstract,
    studyType: 'preprint',
    species: null,
    sampleSize: null,
    funding: [],
    coiStatement: null,
    categories,
    url: arxivId ? `https://arxiv.org/abs/${arxivId}` : null,
  };
}

async function fetchById(arxivId) {
  const cleanId = arxivId.replace(/^arxiv:/i, '').replace(/v\d+$/, '');
  const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(cleanId)}&max_results=1`;
  const xml = await fetchXML(url);
  if (!xml) return null;
  const entry = parseXMLTag(xml, 'entry');
  if (!entry || entry.includes('<title>Error</title>')) return null;
  return parseArxivEntry(entry);
}

async function search(query, maxResults = 5) {
  await sleep(RATE_LIMIT_MS);
  const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${maxResults}`;
  const xml = await fetchXML(url);
  if (!xml) return [];
  const entries = parseXMLTags(xml, 'entry');
  return entries.map((e) => parseArxivEntry(e)).filter((e) => e.title);
}

function matches(src) {
  return !!src.arxivId;
}

async function verify(src) {
  const data = await fetchById(src.arxivId);
  if (!data) {
    return { verified: false, error: `arXiv ID ${src.arxivId} not found`, metadata: null };
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
      actual_all: data.authors,
    });
  }
  if (src.claimedYear && data.year && Math.abs(src.claimedYear - data.year) > 1) {
    issues.push({
      type: 'wrong_year',
      severity: 'high',
      claimed: src.claimedYear,
      actual: data.year,
    });
  }
  return { verified: issues.length === 0, issues, metadata: data };
}

export default {
  id: 'arxiv',
  capabilities: ['query', 'verify'],
  matches,
  search,
  fetchById,
  verify,
};
