import { sleep } from './http.mjs';
import { bestAuthorMatch } from './author-match.mjs';
import pubmed from './adapters/pubmed.mjs';
import europepmc from './adapters/europepmc.mjs';
import arxiv from './adapters/arxiv.mjs';
import semanticScholar from './adapters/semantic-scholar.mjs';
import crossref from './adapters/crossref.mjs';
import openalex from './adapters/openalex.mjs';
import dblp from './adapters/dblp.mjs';
import biorxiv from './adapters/biorxiv.mjs';
import unpaywall from './adapters/unpaywall.mjs';
import rfc from './adapters/rfc.mjs';
import openlibrary from './adapters/openlibrary.mjs';
import chembl from './adapters/chembl.mjs';
import pmc from './adapters/pmc.mjs';

// Ordered by dispatch precedence for verifyNote: PMID → DOI → PMC → arXiv → RFC → ISBN
export const ADAPTERS = [
  pubmed,
  crossref,
  pmc,
  arxiv,
  rfc,
  openlibrary,
  europepmc,
  semanticScholar,
  openalex,
  dblp,
  biorxiv,
  unpaywall,
  chembl,
];

export function findAdapter(src) {
  return ADAPTERS.find((a) => a.matches && a.matches(src)) || null;
}

// Registered sources are the adapters that declare capabilities. biorxiv/chembl/
// unpaywall have none (private enrichers) and are excluded by construction.
const SOURCES = ADAPTERS.filter((a) => Array.isArray(a.capabilities) && a.capabilities.length);

export function sourcesWith(capability) {
  return SOURCES.filter((s) => s.capabilities.includes(capability));
}

function extractAuthorFromQuery(query) {
  const m = query.match(/^([A-Za-zÀ-ɏ-]+(?:\s+et\s+al\.?)?)/);
  return m ? m[1].replace(/\s+et\s+al\.?/, '') : null;
}

export async function resolveSource(query) {
  const claimedAuthor = extractAuthorFromQuery(query);

  const authorField = claimedAuthor ? claimedAuthor + '[Author]' : '';
  const yearMatch = query.match(/((?:19|20)\d{2})/);
  const yearField = yearMatch ? yearMatch[1] + '[Date - Publication]' : '';
  const qualifiedQuery = [authorField, yearField].filter(Boolean).join(' AND ');

  if (qualifiedQuery) {
    const pmids = await pubmed.search(qualifiedQuery, 5);
    if (pmids.length > 0) {
      const candidates = [];
      for (const pmid of pmids.slice(0, 3)) {
        const r = await pubmed.fetchById(pmid);
        if (r) candidates.push(r);
      }
      const match = bestAuthorMatch(candidates, claimedAuthor);
      if (match) return { resolved: true, ...match };
    }
  }

  const pmids = await pubmed.search(query, 5);
  if (pmids.length > 0) {
    const candidates = [];
    for (const pmid of pmids.slice(0, 3)) {
      const r = await pubmed.fetchById(pmid);
      if (r) candidates.push(r);
    }
    const match = bestAuthorMatch(candidates, claimedAuthor);
    if (match) return { resolved: true, ...match };
  }

  await sleep(200);
  const epmcResults = await europepmc.search(query, 5);
  if (epmcResults.length > 0) {
    const match = bestAuthorMatch(epmcResults, claimedAuthor);
    if (match) return { resolved: true, ...match };
  }

  await sleep(200);
  const arxivResults = await arxiv.search(query, 5);
  if (arxivResults.length > 0) {
    const match = bestAuthorMatch(arxivResults, claimedAuthor);
    if (match) return { resolved: true, ...match };
  }

  await sleep(200);
  const s2Results = await semanticScholar.search(query, 5);
  if (s2Results.length > 0) {
    const match = bestAuthorMatch(s2Results, claimedAuthor);
    if (match) return { resolved: true, ...match };
  }

  await sleep(200);
  const crResults = await crossref.search(query, 5);
  if (crResults.length > 0) {
    const match = bestAuthorMatch(crResults, claimedAuthor);
    if (match) return { resolved: true, ...match };
  }

  await sleep(200);
  const oaResults = await openalex.search(query, 5);
  if (oaResults.length > 0) {
    const match = bestAuthorMatch(oaResults, claimedAuthor);
    if (match) return { resolved: true, ...match };
  }

  await sleep(200);
  const dblpResults = await dblp.search(query, 5);
  if (dblpResults.length > 0) {
    const match = bestAuthorMatch(dblpResults, claimedAuthor);
    if (match) return { resolved: true, ...match };
  }

  return { resolved: false, query };
}
