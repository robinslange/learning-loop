// plugin/scripts/librarian/research/fetch.mjs : URL fetch + HTML-to-text for librarian research.
//
// fetchText() pulls a URL and returns { text, ok, reason }. Failures (paywall,
// timeout, network) degrade to ok:false with a reason rather than throwing, so a
// single bad source never aborts a research run. htmlToText() strips scripts,
// styles, and markup to plain prose. fetchOverride is injected for tests.

const DROP_BLOCKS = /<(script|style|noscript|nav|footer|header|aside)[\s\S]*?<\/\1>/gi;

const ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

export function htmlToText(html) {
  let s = html.replace(DROP_BLOCKS, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m] ?? m);
  s = s
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/**
 * Fetch a URL and extract plain text. Never throws.
 * @param {string} url
 * @param {{ timeoutMs?: number, fetchOverride?: typeof fetch }} [opts]
 * @returns {Promise<{ text: string, ok: boolean, reason: string }>}
 */
export async function fetchText(url, opts = {}) {
  const { timeoutMs = 15000, fetchOverride } = opts;
  const fetchFn = fetchOverride || globalThis.fetch;
  let resp;
  try {
    resp = await fetchFn(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (librarian-research)' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const reason =
      err.name === 'TimeoutError' || err.name === 'AbortError' ? 'timeout' : 'fetch_error';
    return { text: '', ok: false, reason };
  }
  if (!resp.ok) return { text: '', ok: false, reason: 'http_' + resp.status };
  try {
    const html = await resp.text();
    return { text: htmlToText(html), ok: true, reason: 'ok' };
  } catch {
    return { text: '', ok: false, reason: 'read_error' };
  }
}
