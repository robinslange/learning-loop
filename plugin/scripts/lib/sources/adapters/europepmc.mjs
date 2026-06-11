import { fetchJSON } from '../http.mjs';

async function search(query, pageSize = 5) {
  const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(query)}&format=json&pageSize=${pageSize}&resultType=core`;
  const data = await fetchJSON(url);
  if (!data?.resultList?.result) return [];
  return data.resultList.result.map((r) => ({
    source: 'europepmc',
    pmid: r.pmid || null,
    pmc: r.pmcid || null,
    doi: r.doi || null,
    title: r.title,
    authors: r.authorString ? r.authorString.split(', ').map((a) => a.replace(/\.$/, '')) : [],
    firstAuthor:
      r.authorList?.author?.[0]?.lastName || (r.authorString || '').split(',')[0]?.trim() || null,
    year: r.pubYear ? parseInt(r.pubYear) : null,
    journal: r.journalTitle || null,
    abstract: r.abstractText || null,
    studyType: r.pubType || null,
    species: null,
    sampleSize: null,
    funding: [],
    coiStatement: null,
    url: r.doi
      ? `https://doi.org/${r.doi}`
      : r.pmid
        ? `https://pubmed.ncbi.nlm.nih.gov/${r.pmid}/`
        : null,
  }));
}

export default { id: 'europepmc', search };
