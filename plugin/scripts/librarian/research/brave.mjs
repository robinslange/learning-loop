// plugin/scripts/librarian/research/brave.mjs : Brave Search API client for librarian research.
//
// search() queries the Brave Web Search REST API and normalises results to
// { url, title, snippet }. The API key is read from the macOS Keychain
// (account=$USER service="brave-search-api-key") to match the Brave MCP wrapper;
// it never lives in config. fetchOverride is injected for tests (network boundary).
import { resolveSecret } from '../../lib/secret.mjs';

const ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

export function getApiKey() {
  return resolveSecret('brave-search-api-key');
}

/**
 * Search Brave; return [{ url, title, snippet }]. Empty array on any failure.
 * @param {string} query
 * @param {{ count?: number, apiKey?: string, fetchOverride?: typeof fetch }} [opts]
 */
export async function search(query, opts = {}) {
  const { count = 6, fetchOverride } = opts;
  const apiKey = opts.apiKey ?? getApiKey();
  if (!apiKey) return [];
  const fetchFn = fetchOverride || globalThis.fetch;
  const url = `${ENDPOINT}?q=${encodeURIComponent(query)}&count=${count}`;
  let resp;
  try {
    resp = await fetchFn(url, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    return [];
  }
  if (!resp.ok) return [];
  try {
    const data = await resp.json();
    const results = data.web?.results || [];
    return results.map((r) => ({ url: r.url, title: r.title, snippet: r.description || '' }));
  } catch {
    return [];
  }
}
