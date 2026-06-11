import { fetchJSON } from '../http.mjs';

async function fetchByDoi(doi) {
  const cleanDoi = doi.replace(/^10\.1101\//, '');
  const url = `https://api.biorxiv.org/details/biorxiv/${cleanDoi}`;
  let data = await fetchJSON(url);
  if (!data?.collection?.length) {
    const murl = `https://api.biorxiv.org/details/medrxiv/${cleanDoi}`;
    data = await fetchJSON(murl);
  }
  if (!data?.collection?.length) return null;
  const p = data.collection[0];
  const authors = p.authors ? p.authors.split('; ').map((a) => a.trim()) : [];
  return {
    source: 'biorxiv',
    pmid: null,
    pmc: null,
    doi: p.doi || doi,
    title: p.title,
    authors,
    firstAuthor: authors[0] || null,
    year: p.date ? parseInt(p.date.substring(0, 4)) : null,
    journal: p.published && p.published !== 'NA' ? p.published : p.server || 'bioRxiv',
    abstract: p.abstract || null,
    studyType: 'preprint',
    species: null,
    sampleSize: null,
    funding: [],
    coiStatement: null,
    url: `https://doi.org/${p.doi || doi}`,
  };
}

export default { id: 'biorxiv', fetchByDoi };
