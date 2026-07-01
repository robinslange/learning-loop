import { fetchJSON } from '../http.mjs';
import { inferStudyType, inferSpecies, inferSampleSize } from '../heuristics.mjs';

async function search(query, limit = 5) {
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${limit}&fields=paperId,title,authors,year,abstract,journal,externalIds,publicationTypes`;
  const data = await fetchJSON(url);
  if (!data?.data) return [];
  return data.data.map((p) => ({
    source: 'semantic_scholar',
    pmid: p.externalIds?.PubMed || null,
    pmc: p.externalIds?.PubMedCentral || null,
    doi: p.externalIds?.DOI || null,
    title: p.title,
    authors: (p.authors || []).map((a) => a.name),
    firstAuthor: p.authors?.[0]?.name || null,
    year: p.year,
    journal: p.journal?.name || null,
    abstract: p.abstract,
    studyType: inferStudyType(p.publicationTypes || [], (p.abstract || '').toLowerCase()),
    species: inferSpecies((p.abstract || '').toLowerCase(), (p.title || '').toLowerCase()),
    sampleSize: inferSampleSize((p.abstract || '').toLowerCase()),
    funding: [],
    coiStatement: null,
    url: p.externalIds?.DOI
      ? `https://doi.org/${p.externalIds.DOI}`
      : `https://api.semanticscholar.org/CorpusID:${p.paperId}`,
  }));
}

export default { id: 'semantic_scholar', capabilities: ['query'], search };
