import { fetchJSON } from '../http.mjs';

async function enrichDoi(doi, config) {
  const email = config?.unpaywall_email;
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
    publisher: data.publisher,
  };
}

export default { id: 'unpaywall', enrichDoi };
