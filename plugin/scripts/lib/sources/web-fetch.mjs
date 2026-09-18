import { warnOnce } from '../warn-once.mjs';
import { isOffline } from '../env.mjs';
import { htmlToText } from '../html-text.mjs';
import { fetchGuarded } from './url-guard.mjs';

export const WEB_FETCH_BLOCKLIST = [
  /sciencedirect\.com/i,
  /linkinghub\.elsevier\.com/i,
  /doi\.org/i,
  /springer\.com/i,
  /tandfonline\.com/i,
  /ieeexplore\.ieee\.org/i,
  /eprints\..*\.ac\.uk/i,
  /\.pdf(\?|$)/i,
];

export function isBlockedFetch(url) {
  return WEB_FETCH_BLOCKLIST.some((re) => re.test(url));
}

// Matches DEFAULT_MAX_BYTES in librarian/research/fetch.mjs. Only prose is kept
// and it is sliced well below this downstream, so the bound is a heap guard
// rather than a content decision.
export const MAX_PAGE_BYTES = 5 * 1024 * 1024;

export async function fetchPageText(url) {
  if (isOffline()) return { ok: false, kind: 'offline' };
  let res;
  try {
    // SSRF gate, every hop. URLs here are scraped out of note bodies by
    // extractSourcesFromNote, and note content can be attacker-authored
    // (/literature <URL>, /ingest repo, a clipped page). The blocklist above is
    // a PAYWALL filter, not a safety one.
    const guarded = await fetchGuarded(url, (hopUrl) =>
      fetch(hopUrl, {
        redirect: 'manual',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; learning-loop/1.0)' },
        signal: AbortSignal.timeout(15000),
      }),
    );
    if (!guarded.ok) {
      if (guarded.reason === 'too_many_redirects') return { ok: false, kind: 'too_many_redirects' };
      return { ok: false, kind: 'blocked', reason: guarded.reason };
    }
    res = guarded.res;
  } catch (err) {
    const kind = err.name === 'TimeoutError' || err.name === 'AbortError' ? 'timeout' : 'network';
    warnOnce(
      `fetchPageText-${kind}`,
      `learning-loop: source-resolver page fetch ${kind} (e.g. ${url}); proceeding without page text. Further ${kind}s will be silent this session.\n`,
    );
    return { ok: false, kind, error: err.message };
  }
  if (!res.ok) {
    return { ok: false, kind: 'http', status: res.status };
  }
  // Same discipline as librarian/research/fetch.mjs: reject by the declared
  // length BEFORE buffering, then re-check the buffer, because content-length
  // is supplied by the same server the body is. The 15s AbortSignal above
  // bounds how long a response may take, not how large it may be, and a slow
  // trickle stays under it while the heap fills. These URLs are scraped out of
  // note bodies, so the size is attacker-chosen.
  const declaredLength = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PAGE_BYTES) {
    return { ok: false, kind: 'too_large' };
  }
  let html;
  try {
    html = await res.text();
  } catch (err) {
    return { ok: false, kind: 'parse', error: err.message };
  }
  if (html.length > MAX_PAGE_BYTES) {
    return { ok: false, kind: 'too_large' };
  }
  return { ok: true, text: htmlToText(html) };
}
