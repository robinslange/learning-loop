import { pubmedSearch, pubmedFetch } from '../lib/sources/adapters/pubmed.mjs';

export async function structuredPubmedSearch(query, useMesh = false) {
  let searchQuery = query;
  if (useMesh) {
    const parts = query.split(/\s+AND\s+/i);
    searchQuery = parts
      .map((p) => {
        if (p.includes('[')) return p;
        return `"${p}"[MeSH]`;
      })
      .join(' AND ');
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
    results,
  };
}
