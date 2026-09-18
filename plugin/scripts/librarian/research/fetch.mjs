// plugin/scripts/librarian/research/fetch.mjs : URL fetch + HTML-to-text for librarian research.
//
// fetchText() pulls a URL and returns { text, ok, reason }. Failures (paywall,
// timeout, network) degrade to ok:false with a reason rather than throwing, so a
// single bad source never aborts a research run. fetchOverride is injected for
// tests.
//
// Markup reduction is lib/html-text.mjs, the same one web-fetch and the abstract
// readers use. This file carried its own copy through the e20d4ad/e21e5d1
// hardening and kept the bypass those commits closed: `<[^>]+>` needs the `>`,
// so an unterminated tag survived and its attribute text was emitted as prose.
// extract.mjs concatenates this output into the local model's prompt, so a page
// author could plant instructions in an unclosed attribute and have them read as
// page content with structural cover.

import { isOffline } from '../../lib/env.mjs';
import { fetchGuarded } from '../../lib/sources/url-guard.mjs';
import { htmlToText } from '../../lib/html-text.mjs';

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Fetch a URL and extract plain text. Never throws.
 * @param {string} url
 * @param {{ timeoutMs?: number, maxBytes?: number, fetchOverride?: typeof fetch }} [opts]
 * @returns {Promise<{ text: string, ok: boolean, reason: string }>}
 */
export async function fetchText(url, opts = {}) {
  if (isOffline()) return { text: '', ok: false, reason: 'offline' };
  const { timeoutMs = 15000, maxBytes = DEFAULT_MAX_BYTES, fetchOverride } = opts;
  const fetchFn = fetchOverride || globalThis.fetch;
  let resp;
  try {
    // Every hop validated, not just the origin: this is the source gateway's
    // fetch slot, i.e. the only egress path once web-guard.js denies WebFetch.
    const guarded = await fetchGuarded(url, (hopUrl) =>
      fetchFn(hopUrl, {
        redirect: 'manual',
        headers: { 'User-Agent': 'Mozilla/5.0 (librarian-research)', Accept: 'text/html,*/*' },
        signal: AbortSignal.timeout(timeoutMs),
      }),
    );
    if (!guarded.ok) return { text: '', ok: false, reason: 'blocked_' + guarded.reason };
    resp = guarded.res;
  } catch (err) {
    const reason =
      err.name === 'TimeoutError' || err.name === 'AbortError' ? 'timeout' : 'fetch_error';
    return { text: '', ok: false, reason };
  }
  if (!resp.ok) return { text: '', ok: false, reason: 'http_' + resp.status };

  // We only extract prose, then slice to ~12k chars downstream. Reject binaries and
  // oversized bodies by their headers BEFORE buffering, so a hostile/large response
  // can't exhaust the heap.
  const contentType = resp.headers?.get?.('content-type');
  if (contentType && !/text\/|\+xml|application\/(xhtml|xml|json)/i.test(contentType)) {
    return { text: '', ok: false, reason: 'non_html' };
  }
  const declaredLength = Number(resp.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return { text: '', ok: false, reason: 'too_large' };
  }

  try {
    const html = await resp.text();
    if (html.length > maxBytes) return { text: '', ok: false, reason: 'too_large' };
    return { text: htmlToText(html), ok: true, reason: 'ok' };
  } catch {
    return { text: '', ok: false, reason: 'read_error' };
  }
}
