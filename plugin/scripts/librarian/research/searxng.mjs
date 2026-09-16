// plugin/scripts/librarian/research/searxng.mjs : SearXNG JSON client for librarian research.
//
// search() queries a self-hosted SearXNG instance and normalises results to
// { url, title, snippet }. The instance URL comes from config
// (sources.providers.searxng.url); there is no key to resolve.
//
// Like brave.mjs this calls fetch directly instead of routing through
// url-guard.mjs. The guard exists for URLs scraped out of note bodies, which are
// attacker-authored; this URL is operator-authored config. It also blocks
// loopback and RFC1918 by design, which is exactly where a self-hosted instance
// lives, so routing this through it would deny the only deployment that matters.
import { isOffline } from '../../lib/env.mjs';
import { loadSourcesConfig } from '../../lib/sources/config.mjs';
import { warnOnce } from '../../lib/warn-once.mjs';

// SearXNG serves JSON only when the admin adds it to `formats` in settings.yml;
// the shipped default is `formats: [html]`. A misconfigured instance answers
// either 403 or 200-with-HTML, and both look identical to "no results" unless
// they are named — so they are named. Silence here is the bug we keep paying for.
const FORMAT_HINT =
  'learning-loop: SearXNG did not return JSON. Add `json` to `formats` in the instance settings.yml.\n';

export function getBaseUrl(cfg) {
  const resolved = cfg || loadSourcesConfig();
  return resolved.providers?.searxng?.url || '';
}

/**
 * Search a SearXNG instance; return [{ url, title, snippet }]. Empty array on any failure.
 * @param {string} query
 * @param {{ count?: number, baseUrl?: string, fetchOverride?: typeof fetch }} [opts]
 */
export async function search(query, opts = {}) {
  if (isOffline()) return [];
  const { count = 6, fetchOverride } = opts;
  const baseUrl = opts.baseUrl ?? getBaseUrl();
  if (!baseUrl) {
    warnOnce(
      'searxng_unconfigured',
      'learning-loop: sources.web_search is "searxng" but sources.providers.searxng.url is unset.\n',
    );
    return [];
  }
  const fetchFn = fetchOverride || globalThis.fetch;
  const url = `${baseUrl.replace(/\/+$/, '')}/search?q=${encodeURIComponent(query)}&format=json`;
  let resp;
  try {
    resp = await fetchFn(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    warnOnce('searxng_unreachable', `learning-loop: SearXNG unreachable at ${baseUrl}.\n`);
    return [];
  }
  if (!resp.ok) {
    warnOnce(
      'searxng_http',
      resp.status === 403 ? FORMAT_HINT : `learning-loop: SearXNG returned HTTP ${resp.status}.\n`,
    );
    return [];
  }
  let data;
  try {
    data = await resp.json();
  } catch {
    warnOnce('searxng_not_json', FORMAT_HINT);
    return [];
  }
  const results = data.results || [];
  return results
    .slice(0, count)
    .map((r) => ({ url: r.url, title: r.title, snippet: r.content || '' }));
}
