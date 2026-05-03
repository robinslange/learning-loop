import { fetchJSON } from '../http.mjs';

async function search(query, maxResults = 5) {
  const url = `https://dblp.org/search/publ/api?q=${encodeURIComponent(query)}&format=json&h=${maxResults}`;
  const data = await fetchJSON(url);
  const hits = data?.result?.hits?.hit;
  if (!hits || !Array.isArray(hits)) return [];
  return hits.map((h) => {
    const info = h.info || {};
    let authors = [];
    if (info.authors?.author) {
      const raw = info.authors.author;
      authors = (Array.isArray(raw) ? raw : [raw]).map((a) =>
        typeof a === 'string' ? a : a.text || '',
      );
    }
    return {
      source: 'dblp',
      pmid: null,
      pmc: null,
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
      url: info.ee || (info.doi ? `https://doi.org/${info.doi}` : null),
    };
  });
}

export default { id: 'dblp', search };
