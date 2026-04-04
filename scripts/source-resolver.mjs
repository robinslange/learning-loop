#!/usr/bin/env node

// Source resolver for the learning-loop pipeline.
// Resolves citations to verified metadata via PubMed, Europe PMC, arXiv, Semantic Scholar,
// CrossRef, OpenAlex, DBLP, Unpaywall, RFC Editor, Open Library, and ChEMBL APIs.
// Maintains a citation index for cross-vault consistency checks.
//
// Usage:
//   source-resolver.mjs resolve "Author Year Topic"        Resolve a citation to verified metadata
//   source-resolver.mjs verify-pmid <pmid> "Author" <year> Verify a specific PMID against claimed author/year
//   source-resolver.mjs verify-doi <doi> "Author" <year>   Verify a specific DOI against claimed author/year
//   source-resolver.mjs verify-note <path>                  Verify all sources in a vault note
//   source-resolver.mjs verify-arxiv <arxiv-id>             Verify an arXiv paper by ID
//   source-resolver.mjs verify-rfc <rfc-number>             Verify an RFC by number
//   source-resolver.mjs verify-isbn <isbn>                  Verify a book by ISBN
//   source-resolver.mjs lookup-compound <name>              Look up a compound in ChEMBL
//   source-resolver.mjs search-pubmed "query" [--mesh]      Structured PubMed search with optional MeSH terms

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, resolve, basename } from 'path';
import { extractAuthorYearCitations } from './lib/cite-extract.mjs';

const DATA_DIR = resolve(join(import.meta.dirname, '..', 'data'));
const INDEX_PATH = join(DATA_DIR, 'citation-index.json');
const CONFIG_PATH = resolve(join(import.meta.dirname, '..', 'data', 'resolver-config.json'));
const RATE_LIMIT_MS = 500; // PubMed: 3 req/sec without API key, padded for safety

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return {};
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')); } catch { return {}; }
}

const CONFIG = loadConfig();

// --- API Clients ---

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

async function fetchXML(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.text();
}

// --- PubMed E-utilities ---

function parseXMLTag(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, 's');
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

function parseXMLTags(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, 'gs');
  const results = [];
  let m;
  while ((m = re.exec(xml)) !== null) results.push(m[1].trim());
  return results;
}

function parseAuthors(xml) {
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

function parseFunding(xml) {
  const grants = parseXMLTags(xml, 'Grant');
  const funding = [];
  for (const g of grants) {
    const agency = parseXMLTag(g, 'Agency');
    if (agency) funding.push(agency);
  }
  const coiStatement = parseXMLTag(xml, 'CoiStatement');
  return { funding, coiStatement: coiStatement || null };
}

function parsePublicationType(xml) {
  return parseXMLTags(xml, 'PublicationType');
}

async function pubmedSearch(query, maxResults = 5) {
  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=${maxResults}&retmode=json`;
  const data = await fetchJSON(url);
  if (!data?.esearchresult?.idlist) return [];
  return data.esearchresult.idlist;
}

async function pubmedFetch(pmid) {
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
  const year = pubDate ? parseInt(parseXMLTag(pubDate, 'Year') || parseXMLTag(pubDate, 'MedlineDate')?.match(/\d{4}/)?.[0]) : null;

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
    url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`
  };
}

// --- Semantic Scholar ---

async function semanticScholarSearch(query, limit = 5) {
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${limit}&fields=paperId,title,authors,year,abstract,journal,externalIds,publicationTypes`;
  const data = await fetchJSON(url);
  if (!data?.data) return [];
  return data.data.map(p => ({
    source: 'semantic_scholar',
    pmid: p.externalIds?.PubMed || null,
    pmc: p.externalIds?.PubMedCentral || null,
    doi: p.externalIds?.DOI || null,
    title: p.title,
    authors: (p.authors || []).map(a => a.name),
    firstAuthor: p.authors?.[0]?.name || null,
    year: p.year,
    journal: p.journal?.name || null,
    abstract: p.abstract,
    studyType: inferStudyType(p.publicationTypes || [], (p.abstract || '').toLowerCase()),
    species: inferSpecies((p.abstract || '').toLowerCase(), (p.title || '').toLowerCase()),
    sampleSize: inferSampleSize((p.abstract || '').toLowerCase()),
    funding: [],
    coiStatement: null,
    url: p.externalIds?.DOI ? `https://doi.org/${p.externalIds.DOI}` : `https://api.semanticscholar.org/CorpusID:${p.paperId}`
  }));
}

// --- CrossRef ---

async function crossrefSearch(query, rows = 5) {
  const url = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(query)}&rows=${rows}&select=DOI,title,author,published-print,published-online,container-title,abstract,type`;
  const data = await fetchJSON(url);
  if (!data?.message?.items) return [];
  return data.message.items.map(item => {
    const authors = (item.author || []).map(a => `${a.family || ''} ${a.given || ''}`.trim());
    const dateArr = item['published-print']?.['date-parts']?.[0] || item['published-online']?.['date-parts']?.[0];
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
      url: `https://doi.org/${item.DOI}`
    };
  });
}

// --- Europe PMC ---

async function europmcSearch(query, pageSize = 5) {
  const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(query)}&format=json&pageSize=${pageSize}&resultType=core`;
  const data = await fetchJSON(url);
  if (!data?.resultList?.result) return [];
  return data.resultList.result.map(r => ({
    source: 'europepmc',
    pmid: r.pmid || null,
    pmc: r.pmcid || null,
    doi: r.doi || null,
    title: r.title,
    authors: r.authorString ? r.authorString.split(', ').map(a => a.replace(/\.$/, '')) : [],
    firstAuthor: r.authorList?.author?.[0]?.lastName || (r.authorString || '').split(',')[0]?.trim() || null,
    year: r.pubYear ? parseInt(r.pubYear) : null,
    journal: r.journalTitle || null,
    abstract: r.abstractText || null,
    studyType: r.pubType || null,
    species: null,
    sampleSize: null,
    funding: [],
    coiStatement: null,
    url: r.doi ? `https://doi.org/${r.doi}` : (r.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${r.pmid}/` : null)
  }));
}

// --- arXiv ---

function parseArxivEntry(entryXml) {
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
    url: arxivId ? `https://arxiv.org/abs/${arxivId}` : null
  };
}

async function arxivFetchById(arxivId) {
  const cleanId = arxivId.replace(/^arxiv:/i, '').replace(/v\d+$/, '');
  const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(cleanId)}&max_results=1`;
  const xml = await fetchXML(url);
  if (!xml) return null;
  const entry = parseXMLTag(xml, 'entry');
  if (!entry || entry.includes('<title>Error</title>')) return null;
  return parseArxivEntry(entry);
}

async function arxivSearch(query, maxResults = 5) {
  await sleep(RATE_LIMIT_MS);
  const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${maxResults}`;
  const xml = await fetchXML(url);
  if (!xml) return [];
  const entries = parseXMLTags(xml, 'entry');
  return entries.map(e => parseArxivEntry(e)).filter(e => e.title);
}

// --- OpenAlex ---

async function openalexSearch(query, perPage = 5) {
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per_page=${perPage}`;
  const data = await fetchJSON(url);
  if (!data?.results) return [];
  return data.results.map(w => {
    const authors = (w.authorships || []).map(a => a.author?.display_name).filter(Boolean);
    return {
      source: 'openalex',
      pmid: w.ids?.pmid?.replace('https://pubmed.ncbi.nlm.nih.gov/', '') || null,
      pmc: null,
      doi: w.doi?.replace('https://doi.org/', '') || null,
      title: w.display_name || w.title,
      authors,
      firstAuthor: authors[0] || null,
      year: w.publication_year,
      journal: w.primary_location?.source?.display_name || null,
      abstract: w.abstract_inverted_index ? reconstructAbstract(w.abstract_inverted_index) : null,
      studyType: w.type || null,
      species: null,
      sampleSize: null,
      funding: [],
      coiStatement: null,
      url: w.doi || w.id
    };
  });
}

function reconstructAbstract(invertedIndex) {
  if (!invertedIndex) return null;
  const words = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    for (const pos of positions) words[pos] = word;
  }
  return words.join(' ');
}

// --- bioRxiv / medRxiv ---

async function biorxivFetchByDoi(doi) {
  const cleanDoi = doi.replace(/^10\.1101\//, '');
  const url = `https://api.biorxiv.org/details/biorxiv/${cleanDoi}`;
  let data = await fetchJSON(url);
  if (!data?.collection?.length) {
    const murl = `https://api.biorxiv.org/details/medrxiv/${cleanDoi}`;
    data = await fetchJSON(murl);
  }
  if (!data?.collection?.length) return null;
  const p = data.collection[0];
  const authors = p.authors ? p.authors.split('; ').map(a => a.trim()) : [];
  return {
    source: 'biorxiv',
    pmid: null,
    pmc: null,
    doi: p.doi || doi,
    title: p.title,
    authors,
    firstAuthor: authors[0] || null,
    year: p.date ? parseInt(p.date.substring(0, 4)) : null,
    journal: p.published && p.published !== 'NA' ? p.published : (p.server || 'bioRxiv'),
    abstract: p.abstract || null,
    studyType: 'preprint',
    species: null,
    sampleSize: null,
    funding: [],
    coiStatement: null,
    url: `https://doi.org/${p.doi || doi}`
  };
}

// --- DBLP ---

async function dblpSearch(query, maxResults = 5) {
  const url = `https://dblp.org/search/publ/api?q=${encodeURIComponent(query)}&format=json&h=${maxResults}`;
  const data = await fetchJSON(url);
  const hits = data?.result?.hits?.hit;
  if (!hits || !Array.isArray(hits)) return [];
  return hits.map(h => {
    const info = h.info || {};
    let authors = [];
    if (info.authors?.author) {
      const raw = info.authors.author;
      authors = (Array.isArray(raw) ? raw : [raw]).map(a => typeof a === 'string' ? a : a.text || '');
    }
    return {
      source: 'dblp',
      pmid: null, pmc: null,
      doi: info.doi || null,
      title: info.title,
      authors,
      firstAuthor: authors[0] || null,
      year: info.year ? parseInt(info.year) : null,
      journal: info.venue || null,
      abstract: null,
      studyType: info.type || null,
      species: null,
      sampleSize: null,
      funding: [],
      coiStatement: null,
      url: info.ee || (info.doi ? `https://doi.org/${info.doi}` : null)
    };
  });
}

// --- Unpaywall ---

async function unpaywallVerifyDoi(doi) {
  const email = CONFIG.unpaywall_email;
  if (!email) return null;
  const url = `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`;
  const data = await fetchJSON(url);
  if (!data || data.error) return null;
  return {
    doi: data.doi,
    title: data.title,
    year: data.year,
    journal: data.journal_name,
    is_oa: data.is_oa,
    oa_url: data.best_oa_location?.url || null,
    publisher: data.publisher
  };
}

// --- RFC Editor ---

async function rfcFetch(rfcNumber) {
  const num = String(rfcNumber).replace(/^rfc/i, '');
  const url = `https://www.rfc-editor.org/rfc/rfc${num}.json`;
  const data = await fetchJSON(url);
  if (!data) return null;
  const authors = (data.authors || []).map(a =>
    typeof a === 'string' ? a : a.name || `${a.given || ''} ${a.family || ''}`.trim()
  );
  return {
    source: 'rfc',
    pmid: null, pmc: null, doi: null,
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
    url: `https://www.rfc-editor.org/rfc/rfc${num}`
  };
}

// --- Open Library (ISBN) ---

async function openLibraryFetchISBN(isbn) {
  const cleanIsbn = isbn.replace(/[-\s]/g, '');
  const url = `https://openlibrary.org/api/books?bibkeys=ISBN:${cleanIsbn}&format=json&jscmd=data`;
  const data = await fetchJSON(url);
  if (!data) return null;
  const entry = data[`ISBN:${cleanIsbn}`];
  if (!entry) return null;
  const authors = (entry.authors || []).map(a => a.name);
  return {
    source: 'openlibrary',
    pmid: null, pmc: null, doi: null,
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
    url: entry.url
  };
}

// --- ChEMBL ---

async function chemblLookup(compoundName) {
  const url = `https://www.ebi.ac.uk/chembl/api/data/molecule?pref_name__iexact=${encodeURIComponent(compoundName)}&format=json`;
  let data = await fetchJSON(url);
  if (!data?.molecules?.length) {
    const searchUrl = `https://www.ebi.ac.uk/chembl/api/data/molecule/search?q=${encodeURIComponent(compoundName)}&format=json`;
    data = await fetchJSON(searchUrl);
  }
  if (!data?.molecules?.length) return null;
  const mol = data.molecules[0];
  return {
    source: 'chembl',
    chemblId: mol.molecule_chembl_id,
    name: mol.pref_name,
    formula: mol.molecule_properties?.full_molformula || null,
    molecularWeight: mol.molecule_properties?.full_mwt || null,
    maxPhase: mol.max_phase,
    firstApproval: mol.first_approval,
    naturalProduct: !!mol.natural_product,
    atcClassifications: mol.atc_classifications || [],
    synonyms: (mol.molecule_synonyms || []).map(s => s.molecule_synonym || s.synonyms),
    url: `https://www.ebi.ac.uk/chembl/compound_report_card/${mol.molecule_chembl_id}/`
  };
}

// --- Heuristic Extractors ---

function inferStudyType(pubTypes, abstractLower) {
  const types = (Array.isArray(pubTypes) ? pubTypes : []).map(t => t.toLowerCase());
  if (types.some(t => t.includes('meta-analysis'))) return 'meta-analysis';
  if (types.some(t => t.includes('systematic review'))) return 'systematic-review';
  if (types.some(t => t.includes('review'))) return 'review';
  if (types.some(t => t.includes('randomized controlled trial'))) return 'RCT';
  if (types.some(t => t.includes('clinical trial'))) return 'clinical-trial';
  if (types.some(t => t.includes('case report'))) return 'case-report';

  if (abstractLower.includes('meta-analysis') || abstractLower.includes('meta analysis')) return 'meta-analysis';
  if (abstractLower.includes('systematic review')) return 'systematic-review';
  if (abstractLower.includes('randomized') || abstractLower.includes('randomised')) return 'RCT';
  if (abstractLower.includes('double-blind') || abstractLower.includes('placebo-controlled')) return 'RCT';
  if (abstractLower.includes('crossover') || abstractLower.includes('cross-over')) return 'crossover-RCT';
  if (abstractLower.includes('open-label')) return 'open-label';
  if (abstractLower.includes('cohort study') || abstractLower.includes('prospective study')) return 'cohort';
  if (abstractLower.includes('in vitro') || abstractLower.includes('cell culture')) return 'in-vitro';
  return 'unknown';
}

function inferSpecies(abstractLower, titleLower) {
  const combined = abstractLower + ' ' + titleLower;
  if (/\b(patients?|participants?|subjects?|volunteers?|adults?|men\b|women\b|children|humans?)\b/.test(combined)) {
    if (/\b(mice|mouse|rats?|rodent|murine)\b/.test(combined)) return 'human+animal';
    return 'human';
  }
  if (/\b(mice|mouse|rats?|rodent|murine)\b/.test(combined)) return 'animal';
  if (/\b(in vitro|cell line|cell culture|hela|hek293)\b/.test(combined)) return 'in-vitro';
  if (/\b(drosophila|zebrafish|c\. elegans|primate)\b/.test(combined)) return 'animal';
  return 'unknown';
}

function inferSampleSize(abstractLower) {
  const nMatch = abstractLower.match(/\bn\s*=\s*(\d+)/i);
  if (nMatch) return parseInt(nMatch[1]);
  const partMatch = abstractLower.match(/(\d+)\s+(participants?|subjects?|patients?|volunteers?|adults?)/);
  if (partMatch) return parseInt(partMatch[1]);
  return null;
}

// --- Cascading Resolver ---

function extractAuthorFromQuery(query) {
  const m = query.match(/^([A-Za-z\u00C0-\u024F-]+(?:\s+et\s+al\.?)?)/);
  return m ? m[1].replace(/\s+et\s+al\.?/, '') : null;
}

function bestAuthorMatch(candidates, claimedAuthor) {
  if (!claimedAuthor || candidates.length === 0) return candidates[0] || null;
  for (const c of candidates) {
    const authors = c.authors || [];
    if (authors.length > 0 && authorMatches(claimedAuthor, authors)) return c;
  }
  return null;
}

async function resolveSource(query) {
  const claimedAuthor = extractAuthorFromQuery(query);

  // PubMed: try field-qualified search first, then fall back to free text
  const authorField = claimedAuthor ? claimedAuthor + '[Author]' : '';
  const yearMatch = query.match(/((?:19|20)\d{2})/);
  const yearField = yearMatch ? yearMatch[1] + '[Date - Publication]' : '';
  const qualifiedQuery = [authorField, yearField].filter(Boolean).join(' AND ');

  if (qualifiedQuery) {
    const pmids = await pubmedSearch(qualifiedQuery, 5);
    if (pmids.length > 0) {
      const candidates = [];
      for (const pmid of pmids.slice(0, 3)) {
        const r = await pubmedFetch(pmid);
        if (r) candidates.push(r);
      }
      const match = bestAuthorMatch(candidates, claimedAuthor);
      if (match) return { resolved: true, ...match };
    }
  }

  // PubMed free-text fallback
  const pmids = await pubmedSearch(query, 5);
  if (pmids.length > 0) {
    const candidates = [];
    for (const pmid of pmids.slice(0, 3)) {
      const r = await pubmedFetch(pmid);
      if (r) candidates.push(r);
    }
    const match = bestAuthorMatch(candidates, claimedAuthor);
    if (match) return { resolved: true, ...match };
  }

  // Europe PMC (broader than PubMed - preprints, clinical guidelines)
  await sleep(200);
  const epmcResults = await europmcSearch(query, 5);
  if (epmcResults.length > 0) {
    const match = bestAuthorMatch(epmcResults, claimedAuthor);
    if (match) return { resolved: true, ...match };
  }

  // arXiv (CS, ML, physics, math preprints)
  await sleep(200);
  const arxivResults = await arxivSearch(query, 5);
  if (arxivResults.length > 0) {
    const match = bestAuthorMatch(arxivResults, claimedAuthor);
    if (match) return { resolved: true, ...match };
  }

  await sleep(200);
  const s2Results = await semanticScholarSearch(query, 5);
  if (s2Results.length > 0) {
    const match = bestAuthorMatch(s2Results, claimedAuthor);
    if (match) return { resolved: true, ...match };
  }

  await sleep(200);
  const crResults = await crossrefSearch(query, 5);
  if (crResults.length > 0) {
    const match = bestAuthorMatch(crResults, claimedAuthor);
    if (match) return { resolved: true, ...match };
  }

  // OpenAlex (catch-all, 250M+ works across all disciplines)
  await sleep(200);
  const oaResults = await openalexSearch(query, 5);
  if (oaResults.length > 0) {
    const match = bestAuthorMatch(oaResults, claimedAuthor);
    if (match) return { resolved: true, ...match };
  }

  // DBLP (CS bibliography fallback)
  await sleep(200);
  const dblpResults = await dblpSearch(query, 5);
  if (dblpResults.length > 0) {
    const match = bestAuthorMatch(dblpResults, claimedAuthor);
    if (match) return { resolved: true, ...match };
  }

  return { resolved: false, query };
}

// --- Verification ---

function normalizeAuthorName(name) {
  return name.toLowerCase().replace(/[^a-z]/g, '');
}

function extractSurnames(name) {
  return name.toLowerCase()
    .split(/[\s,&]+/)
    .filter(s => s.length > 1 && s !== 'et' && s !== 'al' && s !== 'al.')
    .map(s => normalizeAuthorName(s));
}

function authorMatches(claimed, actual) {
  if (!actual || actual.length === 0) return false;
  const claimedSurnames = extractSurnames(claimed);
  return actual.some(a => {
    const actualParts = extractSurnames(a);
    return claimedSurnames.some(cs => actualParts.some(ap =>
      cs === ap || cs.includes(ap) || ap.includes(cs)
    ));
  });
}

function firstAuthorMatches(claimed, actualAuthors) {
  if (!actualAuthors || actualAuthors.length === 0) return false;
  const actualFirst = actualAuthors[0];
  const claimedSurnames = extractSurnames(claimed);
  const actualParts = extractSurnames(actualFirst);
  return claimedSurnames.some(cs => actualParts.some(ap =>
    cs === ap || cs.includes(ap) || ap.includes(cs)
  ));
}

async function verifyPmid(pmid, claimedAuthor, claimedYear) {
  const data = await pubmedFetch(pmid);
  if (!data) return { verified: false, error: 'PMID not found', pmid };

  const issues = [];

  if (claimedAuthor) {
    if (!data.authors || data.authors.length === 0) {
      issues.push({
        type: 'unverifiable_author',
        severity: 'low',
        claimed: claimedAuthor,
        reason: 'no author metadata returned from API'
      });
    } else {
      const isFirstAuthor = firstAuthorMatches(claimedAuthor, data.authors);
      const isAnyAuthor = authorMatches(claimedAuthor, data.authors);
      if (!isFirstAuthor && !isAnyAuthor) {
        issues.push({
          type: 'wrong_author',
          severity: 'high',
          claimed: claimedAuthor,
          actual_first: data.firstAuthor,
          actual_all: data.authors
        });
      } else if (!isFirstAuthor && isAnyAuthor) {
        issues.push({
          type: 'author_not_first',
          severity: 'medium',
          claimed: claimedAuthor,
          actual_first: data.firstAuthor,
          position: data.authors.findIndex(a => authorMatches(claimedAuthor, [a]))
        });
      }
    }
  }

  if (claimedYear && data.year && Math.abs(claimedYear - data.year) > 1) {
    issues.push({ type: 'wrong_year', severity: 'high', claimed: claimedYear, actual: data.year });
  } else if (claimedYear && data.year && claimedYear !== data.year) {
    issues.push({ type: 'year_off_by_one', severity: 'low', claimed: claimedYear, actual: data.year });
  }

  return { verified: issues.length === 0, issues, metadata: data };
}

async function verifyDoi(doi, claimedAuthor, claimedYear) {
  const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
  const data = await fetchJSON(url);
  if (!data?.message) return { verified: false, error: 'DOI not found', doi };

  const item = data.message;
  const authors = (item.author || []).map(a => `${a.family || ''} ${a.given || ''}`.trim());
  const dateArr = item['published-print']?.['date-parts']?.[0] || item['published-online']?.['date-parts']?.[0];
  const year = dateArr?.[0] || null;

  const issues = [];

  if (claimedAuthor) {
    if (!authors || authors.length === 0) {
      issues.push({
        type: 'unverifiable_author',
        severity: 'low',
        claimed: claimedAuthor,
        reason: 'no author metadata returned from API'
      });
    } else if (!firstAuthorMatches(claimedAuthor, authors)) {
      if (!authorMatches(claimedAuthor, authors)) {
        issues.push({ type: 'wrong_author', severity: 'high', claimed: claimedAuthor, actual_first: authors[0], actual_all: authors });
      } else {
        issues.push({ type: 'author_not_first', severity: 'medium', claimed: claimedAuthor, actual_first: authors[0] });
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
      source: 'crossref', doi, title: item.title?.[0], authors, firstAuthor: authors[0],
      year, journal: item['container-title']?.[0], url: `https://doi.org/${doi}`
    }
  };
}

// --- Note Verification ---

function extractSourcesFromNote(content) {
  const sources = [];

  const linkRe = /\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g;
  let m;
  while ((m = linkRe.exec(content)) !== null) {
    const text = m[1];
    const url = m[2];

    const pmidMatch = url.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/);
    const pmcMatch = url.match(/(?:pmc\.ncbi\.nlm\.nih\.gov|ncbi\.nlm\.nih\.gov\/pmc)\/articles\/(PMC\d+)/);
    const doiMatch = url.match(/doi\.org\/(.+)/);
    const arxivUrlMatch = url.match(/arxiv\.org\/abs\/(\d{4}\.\d{4,5}(?:v\d+)?)/);
    const rfcUrlMatch = url.match(/rfc-editor\.org\/rfc\/rfc(\d{3,5})/);

    const authorYearMatch = text.match(/^([A-Z][a-z\u00C0-\u024F]+(?:\s+(?:et\s+al\.?|&\s+[A-Z][a-z\u00C0-\u024F]+|[A-Z][a-z\u00C0-\u024F]+))*)\s*[\(,]?\s*(\d{4})/);

    sources.push({
      text,
      url,
      pmid: pmidMatch?.[1] || null,
      pmc: pmcMatch?.[1] || null,
      doi: doiMatch?.[1] || null,
      arxivId: arxivUrlMatch?.[1]?.replace(/v\d+$/, '') || null,
      rfcNumber: rfcUrlMatch?.[1] || null,
      claimedAuthor: authorYearMatch?.[1] || null,
      claimedYear: authorYearMatch?.[2] ? parseInt(authorYearMatch[2]) : null
    });
  }

  // Match "PMID 12345678" or "PubMed 12345678"
  const pmidInlineRe = /(?:PMID|PubMed)\s+(\d{7,8})/gi;
  while ((m = pmidInlineRe.exec(content)) !== null) {
    const pmid = m[1];
    if (!sources.some(s => s.pmid === pmid)) {
      // Try to find the author/year context around this PMID
      const surrounding = content.substring(Math.max(0, m.index - 100), m.index);
      const authorYearMatch = surrounding.match(/([A-Z][a-z\u00C0-\u024F]+(?:-[A-Z][a-z\u00C0-\u024F]+)*(?:\s+(?:et\s+al\.?|&\s+[A-Z][a-z\u00C0-\u024F]+))*)\s*[\(,]?\s*((?:19|20)\d{2})/);
      sources.push({
        text: `PMID ${pmid}`,
        url: null,
        pmid,
        pmc: null, doi: null,
        claimedAuthor: authorYearMatch?.[1] || null,
        claimedYear: authorYearMatch?.[2] ? parseInt(authorYearMatch[2]) : null
      });
    }
  }

  // Match "PMC1234567" or "PMC 1234567"
  const pmcInlineRe = /PMC\s?(\d{5,8})/g;
  while ((m = pmcInlineRe.exec(content)) !== null) {
    const pmc = `PMC${m[1]}`;
    if (!sources.some(s => s.pmc === pmc)) {
      const surrounding = content.substring(Math.max(0, m.index - 100), m.index);
      const authorYearMatch = surrounding.match(/([A-Z][a-z\u00C0-\u024F]+(?:-[A-Z][a-z\u00C0-\u024F]+)*(?:\s+(?:et\s+al\.?|&\s+[A-Z][a-z\u00C0-\u024F]+))*)\s*[\(,]?\s*((?:19|20)\d{2})/);
      sources.push({
        text: `${pmc}`,
        url: null,
        pmid: null,
        pmc,
        doi: null,
        claimedAuthor: authorYearMatch?.[1] || null,
        claimedYear: authorYearMatch?.[2] ? parseInt(authorYearMatch[2]) : null
      });
    }
  }

  // Match inline author+year citations via POS tagging (replaces naive regex)
  const posMatches = extractAuthorYearCitations(content);
  for (const { author, year } of posMatches) {
    if (!sources.some(s => s.claimedAuthor === author && s.claimedYear === year) &&
        !sources.some(s => s.claimedAuthor?.includes(author) && s.claimedYear === year)) {
      sources.push({
        text: `${author} ${year}`,
        url: null,
        pmid: null, pmc: null, doi: null,
        claimedAuthor: author,
        claimedYear: year
      });
    }
  }

  // Match arXiv IDs: "arXiv:1706.03762" or "arxiv.org/abs/1706.03762"
  const arxivInlineRe = /(?:arXiv:\s*|arxiv\.org\/abs\/)(\d{4}\.\d{4,5}(?:v\d+)?)/gi;
  while ((m = arxivInlineRe.exec(content)) !== null) {
    const arxivId = m[1].replace(/v\d+$/, '');
    if (!sources.some(s => s.arxivId === arxivId)) {
      sources.push({
        text: `arXiv:${arxivId}`,
        url: `https://arxiv.org/abs/${arxivId}`,
        pmid: null, pmc: null, doi: null,
        arxivId,
        claimedAuthor: null,
        claimedYear: null
      });
    }
  }

  // Match RFC references: "RFC 9110", "RFC9110", "rfc-editor.org/rfc/rfc9110"
  const rfcInlineRe = /(?:RFC\s*(\d{3,5})|rfc-editor\.org\/rfc\/rfc(\d{3,5}))/gi;
  while ((m = rfcInlineRe.exec(content)) !== null) {
    const rfcNum = m[1] || m[2];
    if (!sources.some(s => s.rfcNumber === rfcNum)) {
      sources.push({
        text: `RFC ${rfcNum}`,
        url: `https://www.rfc-editor.org/rfc/rfc${rfcNum}`,
        pmid: null, pmc: null, doi: null,
        rfcNumber: rfcNum,
        claimedAuthor: null,
        claimedYear: null
      });
    }
  }

  // Match ISBNs: "ISBN 978-0-14-312779-6", "ISBN: 9780143127796", "ISBN 90-5699-501-4"
  const isbnInlineRe = /ISBN[:\s]*([\d][\d\s-]{8,16}[\dX])/gi;
  while ((m = isbnInlineRe.exec(content)) !== null) {
    const isbn = m[1].replace(/[-\s]/g, '');
    if (!sources.some(s => s.isbn === isbn)) {
      sources.push({
        text: `ISBN ${isbn}`,
        url: null,
        pmid: null, pmc: null, doi: null,
        isbn,
        claimedAuthor: null,
        claimedYear: null
      });
    }
  }

  return sources;
}

function extractNoteTopicKeywords(content) {
  const titleMatch = content.match(/^#\s+(.+)$/m);
  if (!titleMatch) return '';
  return titleMatch[1]
    .replace(/[-_]/g, ' ')
    .replace(/\b(is|are|the|a|an|and|or|but|not|for|in|on|of|to|with|by|from|as|at|vs|has|have|had|was|were|be|been)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 4)
    .join(' ');
}

async function verifyNote(notePath) {
  const content = readFileSync(notePath, 'utf-8');
  const sources = extractSourcesFromNote(content);
  const noteFilename = basename(notePath);
  const topicKeywords = extractNoteTopicKeywords(content);
  const results = [];

  for (const src of sources) {
    let result;
    if (src.pmid) {
      result = await verifyPmid(src.pmid, src.claimedAuthor, src.claimedYear);
    } else if (src.doi) {
      result = await verifyDoi(src.doi, src.claimedAuthor, src.claimedYear);
      if (!result.verified && result.error === 'DOI not found' && src.doi.startsWith('10.1101/')) {
        const biorxiv = await biorxivFetchByDoi(src.doi);
        if (biorxiv) {
          const issues = [];
          if (src.claimedAuthor && biorxiv.authors.length > 0 && !authorMatches(src.claimedAuthor, biorxiv.authors)) {
            issues.push({ type: 'wrong_author', severity: 'high', claimed: src.claimedAuthor, actual_first: biorxiv.firstAuthor });
          }
          if (src.claimedYear && biorxiv.year && Math.abs(src.claimedYear - biorxiv.year) > 1) {
            issues.push({ type: 'wrong_year', severity: 'high', claimed: src.claimedYear, actual: biorxiv.year });
          }
          result = { verified: issues.length === 0, issues, metadata: biorxiv };
        }
      }
    } else if (src.pmc) {
      const pmcId = src.pmc.replace(/^PMC/i, '');
      const convertUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pmc&id=${pmcId}&retmode=json`;
      await sleep(RATE_LIMIT_MS);
      let data = await fetchJSON(convertUrl);
      if (!data?.result?.[pmcId]) {
        await sleep(1000);
        data = await fetchJSON(convertUrl);
      }
      const pmcResult = data?.result?.[pmcId];
      if (pmcResult) {
        const pmcAuthors = (pmcResult.authors || []).map(a => a.name || '');
        const pmcYear = parseInt(pmcResult.pubdate?.match(/\d{4}/)?.[0]) || null;
        const pmcTitle = pmcResult.title || null;
        const issues = [];
        if (src.claimedAuthor) {
          if (pmcAuthors.length === 0) {
            issues.push({ type: 'unverifiable_author', severity: 'low', claimed: src.claimedAuthor, reason: 'no author metadata from PMC' });
          } else if (!firstAuthorMatches(src.claimedAuthor, pmcAuthors)) {
            if (!authorMatches(src.claimedAuthor, pmcAuthors)) {
              issues.push({ type: 'wrong_author', severity: 'high', claimed: src.claimedAuthor, actual_first: pmcAuthors[0], actual_all: pmcAuthors });
            } else {
              issues.push({ type: 'author_not_first', severity: 'medium', claimed: src.claimedAuthor, actual_first: pmcAuthors[0] });
            }
          }
        }
        if (src.claimedYear && pmcYear && Math.abs(src.claimedYear - pmcYear) > 1) {
          issues.push({ type: 'wrong_year', severity: 'high', claimed: src.claimedYear, actual: pmcYear });
        }
        result = { verified: issues.length === 0, issues, metadata: { source: 'pmc', pmc: src.pmc, title: pmcTitle, authors: pmcAuthors, firstAuthor: pmcAuthors[0] || null, year: pmcYear } };
      } else {
        result = { verified: false, error: `Could not resolve ${src.pmc}`, metadata: null };
      }
    } else if (src.arxivId) {
      const data = await arxivFetchById(src.arxivId);
      if (data) {
        const issues = [];
        if (src.claimedAuthor && data.authors.length > 0 && !authorMatches(src.claimedAuthor, data.authors)) {
          issues.push({ type: 'wrong_author', severity: 'high', claimed: src.claimedAuthor, actual_first: data.firstAuthor, actual_all: data.authors });
        }
        if (src.claimedYear && data.year && Math.abs(src.claimedYear - data.year) > 1) {
          issues.push({ type: 'wrong_year', severity: 'high', claimed: src.claimedYear, actual: data.year });
        }
        result = { verified: issues.length === 0, issues, metadata: data };
      } else {
        result = { verified: false, error: `arXiv ID ${src.arxivId} not found`, metadata: null };
      }
    } else if (src.rfcNumber) {
      const data = await rfcFetch(src.rfcNumber);
      if (data) {
        result = { verified: true, issues: [], metadata: data };
      } else {
        result = { verified: false, error: `RFC ${src.rfcNumber} not found`, metadata: null };
      }
    } else if (src.isbn) {
      const data = await openLibraryFetchISBN(src.isbn);
      if (data) {
        const issues = [];
        if (src.claimedAuthor && data.authors.length > 0 && !authorMatches(src.claimedAuthor, data.authors)) {
          issues.push({ type: 'wrong_author', severity: 'high', claimed: src.claimedAuthor, actual_first: data.firstAuthor });
        }
        result = { verified: issues.length === 0, issues, metadata: data };
      } else {
        result = { verified: false, error: `ISBN ${src.isbn} not found in Open Library`, metadata: null };
      }
    } else if (src.claimedAuthor && src.claimedYear) {
      const query = topicKeywords
        ? `${src.claimedAuthor} ${src.claimedYear} ${topicKeywords}`
        : `${src.claimedAuthor} ${src.claimedYear}`;
      const resolved = await resolveSource(query);
      if (resolved.resolved) {
        const issues = [];
        const resolvedAuthors = resolved.authors || [];
        if (resolvedAuthors.length === 0) {
          issues.push({ type: 'unverifiable_author', severity: 'low', claimed: src.claimedAuthor, reason: 'no author metadata from resolver' });
        } else if (!firstAuthorMatches(src.claimedAuthor, resolvedAuthors)) {
          if (!authorMatches(src.claimedAuthor, resolvedAuthors)) {
            issues.push({ type: 'wrong_author', severity: 'high', claimed: src.claimedAuthor, actual_first: resolved.firstAuthor });
          }
        }
        result = { verified: issues.length === 0, issues, metadata: resolved };
      } else {
        result = { verified: false, error: 'Source not found in any database', metadata: null };
      }
    } else {
      result = { verified: false, error: 'No identifiable source information', metadata: null };
    }

    // Unpaywall enrichment for any source with a DOI
    if (result.metadata?.doi) {
      const unpaywall = await unpaywallVerifyDoi(result.metadata.doi);
      if (unpaywall) {
        result.metadata.is_oa = unpaywall.is_oa;
        result.metadata.oa_url = unpaywall.oa_url;
      }
    }

    if (result.metadata?.pmid) {
      updateCitationIndex(result.metadata.pmid, result.metadata, noteFilename);
    }

    results.push({ source: src, ...result });
  }

  const index = loadCitationIndex();
  const crossVaultIssues = [];
  for (const r of results) {
    if (r.metadata?.pmid) {
      const entry = index[`pmid:${r.metadata.pmid}`];
      if (entry && entry.cited_in.length > 1) {
        crossVaultIssues.push({
          pmid: r.metadata.pmid,
          cited_in: entry.cited_in,
          authors: entry.authors
        });
      }
    }
  }

  return { notePath, sources: results, crossVaultIssues };
}

// --- Citation Index ---

function loadCitationIndex() {
  if (!existsSync(INDEX_PATH)) return {};
  return JSON.parse(readFileSync(INDEX_PATH, 'utf-8'));
}

function saveCitationIndex(index) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2));
}

function updateCitationIndex(pmid, metadata, noteFilename) {
  const index = loadCitationIndex();
  const key = `pmid:${pmid}`;
  if (!index[key]) {
    index[key] = {
      authors: metadata.authors || [],
      title: metadata.title || '',
      year: metadata.year || null,
      cited_in: []
    };
  }
  if (!index[key].cited_in.includes(noteFilename)) {
    index[key].cited_in.push(noteFilename);
  }
  saveCitationIndex(index);
}

// --- Structured PubMed Search ---

async function structuredPubmedSearch(query, useMesh = false) {
  let searchQuery = query;
  if (useMesh) {
    const parts = query.split(/\s+AND\s+/i);
    searchQuery = parts.map(p => {
      if (p.includes('[')) return p;
      return `"${p}"[MeSH]`;
    }).join(' AND ');
  }

  const pmids = await pubmedSearch(searchQuery, 20);
  const results = [];

  for (const pmid of pmids.slice(0, 10)) {
    const data = await pubmedFetch(pmid);
    if (data) results.push(data);
  }

  return {
    query: searchQuery,
    totalFound: pmids.length,
    retrieved: results.length,
    results
  };
}

// --- Claim-Number Extraction ---

const NUMBER_PATTERNS = [
  /\b(?:OR|HR|RR|IRR|AOR|aOR)\s*(?:=\s*)?(\d+\.?\d*)/gi,
  /\b(?:d|g|Cohen[\u2019']?s?\s*d)\s*=?\s*(\d+\.?\d*)/gi,
  /\b(\d+\.?\d*)\s*%/g,
  /\bn\s*=\s*(\d+)/gi,
  /\b(\d+)\s+(?:patients?|participants?|subjects?|studies)/gi,
  /\bp\s*[<>=]\s*(0?\.\d+)/gi,
  /\b(\d+\.?\d*)\s*(?:mg|mcg|\u00b5g|ml|mL|mg\/L|ng\/mL)/gi,
  /\b(\d+\.?\d*)-fold/gi,
  /\b(\d+\.?\d*)\s*(?:ms|seconds?|minutes?|hours?|days?|weeks?|months?)\b/gi,
];

function extractNumbers(text) {
  const numbers = new Set();
  for (const re of NUMBER_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      numbers.add(m[1] || m[0]);
    }
  }
  return [...numbers];
}

function findNumberInAbstract(number, abstract) {
  if (!abstract) return { found: false, excerpt: null };
  const escaped = number.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('.{0,60}' + escaped + '.{0,60}', 'i');
  const match = abstract.match(re);
  return match ? { found: true, excerpt: match[0].trim() } : { found: false, excerpt: null };
}

async function checkClaims(notePath) {
  const content = readFileSync(notePath, 'utf-8');
  const sources = extractSourcesFromNote(content);

  // Strip frontmatter for number extraction
  const bodyMatch = content.match(/^---[\s\S]*?---\s*\n([\s\S]*)$/);
  const body = bodyMatch ? bodyMatch[1] : content;
  const allNumbers = extractNumbers(body);
  if (allNumbers.length === 0) return [];

  const results = [];

  for (const src of sources) {
    let metadata = null;

    if (src.pmid) {
      metadata = await pubmedFetch(src.pmid);
    } else if (src.arxivId) {
      metadata = await arxivFetchById(src.arxivId);
    } else if (src.doi) {
      const url = 'https://api.crossref.org/works/' + encodeURIComponent(src.doi);
      const crData = await fetchJSON(url);
      if (crData?.message) {
        const abstract = (crData.message.abstract || '').replace(/<[^>]+>/g, '');
        metadata = { abstract, title: crData.message.title?.[0] };
      }
    }

    if (!metadata?.abstract) continue;

    const srcLabel = src.claimedAuthor ? (src.claimedAuthor + ' ' + (src.claimedYear || '')).trim() : (src.pmid || src.doi);

    for (const num of allNumbers) {
      const { found, excerpt } = findNumberInAbstract(num, metadata.abstract);
      results.push({
        source: srcLabel,
        pmid: src.pmid || null,
        doi: src.doi || null,
        claim: num,
        in_abstract: found,
        abstract_excerpt: excerpt
      });
    }
  }

  return results;
}

// --- CLI ---

async function main() {
  const [,, command, ...args] = process.argv;

  if (!command) {
    console.log(`Usage:
  source-resolver.mjs resolve "Author Year Topic"        Resolve a citation to verified metadata
  source-resolver.mjs verify-pmid <pmid> "Author" <year> Verify a specific PMID against claimed author/year
  source-resolver.mjs verify-doi <doi> "Author" <year>   Verify a specific DOI against claimed author/year
  source-resolver.mjs verify-arxiv <arxiv-id>             Verify an arXiv paper by ID (e.g. 1706.03762)
  source-resolver.mjs verify-rfc <rfc-number>             Verify an RFC by number (e.g. 9110)
  source-resolver.mjs verify-isbn <isbn>                  Verify a book by ISBN
  source-resolver.mjs verify-note <path>                  Verify all sources in a vault note
  source-resolver.mjs lookup-compound <name>              Look up a compound in ChEMBL
  source-resolver.mjs check-claims <path>                 Check quantitative claims against source abstracts
  source-resolver.mjs search-pubmed "query" [--mesh]      Structured PubMed search with optional MeSH terms`);
    process.exit(1);
  }

  let result;

  switch (command) {
    case 'resolve':
      result = await resolveSource(args.join(' '));
      break;
    case 'verify-pmid':
      result = await verifyPmid(args[0], args[1], args[2] ? parseInt(args[2]) : null);
      break;
    case 'verify-doi':
      result = await verifyDoi(args[0], args[1], args[2] ? parseInt(args[2]) : null);
      break;
    case 'verify-arxiv':
      result = await arxivFetchById(args[0]);
      if (!result) result = { error: `arXiv ID ${args[0]} not found` };
      break;
    case 'verify-rfc':
      result = await rfcFetch(args[0]);
      if (!result) result = { error: `RFC ${args[0]} not found` };
      break;
    case 'verify-isbn':
      result = await openLibraryFetchISBN(args[0]);
      if (!result) result = { error: `ISBN ${args[0]} not found in Open Library` };
      break;
    case 'lookup-compound':
      result = await chemblLookup(args.join(' '));
      if (!result) result = { error: `Compound "${args.join(' ')}" not found in ChEMBL` };
      break;
    case 'verify-note':
      result = await verifyNote(resolve(args[0]));
      break;
    case 'search-pubmed':
      result = await structuredPubmedSearch(args.filter(a => a !== '--mesh').join(' '), args.includes('--mesh'));
      break;
    case 'check-claims':
      result = await checkClaims(resolve(args[0]));
      break;
    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }

  console.log(JSON.stringify(result, null, 2));
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
