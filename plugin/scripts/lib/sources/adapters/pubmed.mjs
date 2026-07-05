import { fetchJSON, fetchXML, sleep, RATE_LIMIT_MS } from '../http.mjs';
import { parseXMLTag, parseXMLTags } from '../xml.mjs';
import { inferStudyType, inferSpecies, inferSampleSize } from '../heuristics.mjs';
import { authorMatches, firstAuthorMatches } from '../author-match.mjs';

export function parseAuthors(xml) {
  const authorList = parseXMLTag(xml, 'AuthorList');
  if (!authorList) return [];
  const authors = [];
  const authorBlocks = parseXMLTags(authorList, 'Author');
  for (const block of authorBlocks) {
    const last = parseXMLTag(block, 'LastName');
    const fore = parseXMLTag(block, 'ForeName') || parseXMLTag(block, 'Initials');
    if (last) authors.push(fore ? `${last} ${fore}` : last);
  }
  return authors;
}

export function parseFunding(xml) {
  const grants = parseXMLTags(xml, 'Grant');
  const funding = [];
  for (const g of grants) {
    const agency = parseXMLTag(g, 'Agency');
    if (agency) funding.push(agency);
  }
  const coiStatement = parseXMLTag(xml, 'CoiStatement');
  return { funding, coiStatement: coiStatement || null };
}

export function parsePublicationType(xml) {
  return parseXMLTags(xml, 'PublicationType');
}

export async function pubmedSearch(query, maxResults = 5) {
  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=${maxResults}&retmode=json`;
  const data = await fetchJSON(url);
  if (!data?.esearchresult?.idlist) return [];
  return data.esearchresult.idlist;
}

export async function pubmedFetch(pmid) {
  await sleep(RATE_LIMIT_MS);
  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${pmid}&retmode=xml`;
  const xml = await fetchXML(url);
  if (!xml) return null;

  const article = parseXMLTag(xml, 'PubmedArticle') || xml;
  const title = parseXMLTag(article, 'ArticleTitle');
  const authors = parseAuthors(article);
  const abstractText = parseXMLTag(article, 'AbstractText') || parseXMLTag(article, 'Abstract');
  const journal = parseXMLTag(article, 'Title') || parseXMLTag(article, 'ISOAbbreviation');
  const pubTypes = parsePublicationType(article);
  const { funding, coiStatement } = parseFunding(article);

  const pubDate = parseXMLTag(article, 'PubDate');
  const year = pubDate
    ? parseInt(
        parseXMLTag(pubDate, 'Year') || parseXMLTag(pubDate, 'MedlineDate')?.match(/\d{4}/)?.[0],
      )
    : null;

  const elocationIds = parseXMLTags(article, 'ELocationID');
  let doi = null;
  for (const eid of elocationIds) {
    if (eid.includes('doi')) {
      doi = eid.replace(/<[^>]+>/g, '').trim();
    }
  }
  if (!doi) {
    const articleIds = parseXMLTag(article, 'ArticleIdList') || '';
    const doiMatch = articleIds.match(/<ArticleId IdType="doi">(.*?)<\/ArticleId>/);
    if (doiMatch) doi = doiMatch[1];
  }

  const articleIds = parseXMLTag(article, 'ArticleIdList') || '';
  const pmcMatch = articleIds.match(/<ArticleId IdType="pmc">(.*?)<\/ArticleId>/);
  const pmc = pmcMatch ? pmcMatch[1] : null;

  const abstractLower = (abstractText || '').toLowerCase();
  const studyType = inferStudyType(pubTypes, abstractLower);
  const species = inferSpecies(abstractLower, title?.toLowerCase() || '');
  const sampleSize = inferSampleSize(abstractLower);

  return {
    source: 'pubmed',
    pmid,
    pmc,
    doi,
    title,
    authors,
    firstAuthor: authors[0] || null,
    year,
    journal,
    abstract: abstractText,
    studyType,
    species,
    sampleSize,
    funding,
    coiStatement,
    url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
  };
}

function matches(src) {
  return !!src.pmid;
}

async function search(query, max = 5) {
  return pubmedSearch(query, max);
}

async function verify(src) {
  const data = await pubmedFetch(src.pmid);
  if (!data) return { verified: false, error: 'PMID not found', pmid: src.pmid };

  const issues = [];

  if (src.claimedAuthor) {
    if (!data.authors || data.authors.length === 0) {
      issues.push({
        type: 'unverifiable_author',
        severity: 'low',
        claimed: src.claimedAuthor,
        reason: 'no author metadata returned from API',
      });
    } else {
      const isFirstAuthor = firstAuthorMatches(src.claimedAuthor, data.authors);
      const isAnyAuthor = authorMatches(src.claimedAuthor, data.authors);
      if (!isFirstAuthor && !isAnyAuthor) {
        issues.push({
          type: 'wrong_author',
          severity: 'high',
          claimed: src.claimedAuthor,
          actual_first: data.firstAuthor,
          actual_all: data.authors,
        });
      } else if (!isFirstAuthor && isAnyAuthor) {
        issues.push({
          type: 'author_not_first',
          severity: 'medium',
          claimed: src.claimedAuthor,
          actual_first: data.firstAuthor,
          position: data.authors.findIndex((a) => authorMatches(src.claimedAuthor, [a])),
        });
      }
    }
  }

  if (src.claimedYear && data.year && Math.abs(src.claimedYear - data.year) > 1) {
    issues.push({
      type: 'wrong_year',
      severity: 'high',
      claimed: src.claimedYear,
      actual: data.year,
    });
  } else if (src.claimedYear && data.year && src.claimedYear !== data.year) {
    issues.push({
      type: 'year_off_by_one',
      severity: 'low',
      claimed: src.claimedYear,
      actual: data.year,
    });
  }

  return { verified: issues.length === 0, issues, metadata: data };
}

export default {
  id: 'pubmed',
  capabilities: ['query', 'verify'],
  matches,
  search,
  fetchById: pubmedFetch,
  verify,
};
