import { fetchJSON } from '../http.mjs';
import { reconstructAbstract } from '../heuristics.mjs';

async function search(query, perPage = 5) {
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per_page=${perPage}`;
  const data = await fetchJSON(url);
  if (!data?.results) return [];
  return data.results.map((w) => {
    const authors = (w.authorships || []).map((a) => a.author?.display_name).filter(Boolean);
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
      url: w.doi || w.id,
    };
  });
}

export default { id: 'openalex', capabilities: ['query'], search };
