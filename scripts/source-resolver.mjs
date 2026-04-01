#!/usr/bin/env node

// Source resolver for the learning-loop pipeline.
// Resolves citations to verified metadata via PubMed, Semantic Scholar, and CrossRef APIs.
// Maintains a citation index for cross-vault consistency checks.
//
// Usage:
//   source-resolver.mjs resolve "Author Year Topic"        Resolve a citation to verified metadata
//   source-resolver.mjs verify-pmid <pmid> "Author" <year> Verify a specific PMID against claimed author/year
//   source-resolver.mjs verify-doi <doi> "Author" <year>   Verify a specific DOI against claimed author/year
//   source-resolver.mjs verify-note <path>                  Verify all sources in a vault note
//   source-resolver.mjs search-pubmed "query" [--mesh]      Structured PubMed search with optional MeSH terms

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, resolve, basename } from 'path';

const DATA_DIR = resolve(join(import.meta.dirname, '..', 'data'));
const INDEX_PATH = join(DATA_DIR, 'citation-index.json');
const RATE_LIMIT_MS = 500; // PubMed: 3 req/sec without API key, padded for safety

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

async function resolveSource(query) {
  const pmids = await pubmedSearch(query);
  if (pmids.length > 0) {
    const result = await pubmedFetch(pmids[0]);
    if (result) return { resolved: true, ...result };
  }

  await sleep(200);
  const s2Results = await semanticScholarSearch(query);
  if (s2Results.length > 0) return { resolved: true, ...s2Results[0] };

  await sleep(200);
  const crResults = await crossrefSearch(query);
  if (crResults.length > 0) return { resolved: true, ...crResults[0] };

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

    const authorYearMatch = text.match(/^([A-Z][a-z\u00C0-\u024F]+(?:\s+(?:et\s+al\.?|&\s+[A-Z][a-z\u00C0-\u024F]+|[A-Z][a-z\u00C0-\u024F]+))*)\s*[\(,]?\s*(\d{4})/);

    sources.push({
      text,
      url,
      pmid: pmidMatch?.[1] || null,
      pmc: pmcMatch?.[1] || null,
      doi: doiMatch?.[1] || null,
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

  // Match inline author+year citations that weren't already captured
  const inlineRe = /\b([A-Z][a-z\u00C0-\u024F]+(?:-[A-Z][a-z\u00C0-\u024F]+)*(?:\s+(?:et\s+al\.?|&\s+[A-Z][a-z\u00C0-\u024F]+(?:-[A-Z][a-z\u00C0-\u024F]+)*))*)\s*[\(,]?\s*((?:19|20)\d{2})\b/g;
  while ((m = inlineRe.exec(content)) !== null) {
    const author = m[1];
    const year = parseInt(m[2]);
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

  return sources;
}

async function verifyNote(notePath) {
  const content = readFileSync(notePath, 'utf-8');
  const sources = extractSourcesFromNote(content);
  const noteFilename = basename(notePath);
  const results = [];

  for (const src of sources) {
    let result;
    if (src.pmid) {
      result = await verifyPmid(src.pmid, src.claimedAuthor, src.claimedYear);
    } else if (src.doi) {
      result = await verifyDoi(src.doi, src.claimedAuthor, src.claimedYear);
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
    } else if (src.claimedAuthor && src.claimedYear) {
      const resolved = await resolveSource(`${src.claimedAuthor} ${src.claimedYear}`);
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

// --- CLI ---

async function main() {
  const [,, command, ...args] = process.argv;

  if (!command) {
    console.log(`Usage:
  source-resolver.mjs resolve "Author Year Topic"
  source-resolver.mjs verify-pmid <pmid> "Author" <year>
  source-resolver.mjs verify-doi <doi> "Author" <year>
  source-resolver.mjs verify-note <path>
  source-resolver.mjs search-pubmed "query" [--mesh]`);
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
    case 'verify-note':
      result = await verifyNote(resolve(args[0]));
      break;
    case 'search-pubmed':
      result = await structuredPubmedSearch(args.filter(a => a !== '--mesh').join(' '), args.includes('--mesh'));
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
