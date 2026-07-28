import { warnOnce } from '../warn-once.mjs';
import { isOffline } from '../env.mjs';
import { checkFetchUrl, checkRedirect } from './url-guard.mjs';

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

const MAX_REDIRECTS = 5;

export async function fetchPageText(url) {
  if (isOffline()) return { ok: false, kind: 'offline' };
  // SSRF gate. URLs here are scraped out of note bodies by extractSourcesFromNote,
  // and note content can be attacker-authored (/literature <URL>, /ingest repo, a
  // clipped page). The blocklist above is a PAYWALL filter, not a safety one.
  const guard = checkFetchUrl(url);
  if (!guard.ok) return { ok: false, kind: 'blocked', reason: guard.reason };
  let res;
  try {
    // Manual redirects so each hop is re-checked: `redirect: 'follow'` lets a
    // public host 302 into loopback or cloud IMDS behind a clean origin URL.
    let current = guard.url.href;
    for (let hop = 0; ; hop++) {
      res = await fetch(current, {
        redirect: 'manual',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; learning-loop/1.0)' },
        signal: AbortSignal.timeout(15000),
      });
      // Treat as a redirect only on an explicit 3xx WITH a Location header.
      // A response lacking `status`/`headers` (a stubbed fetch) is a terminal
      // response, not a redirect — defaulting the other way spins the loop.
      const status = typeof res.status === 'number' ? res.status : 200;
      if (status < 300 || status >= 400) break;
      const location = res.headers?.get?.('location');
      if (!location) break;
      if (hop >= MAX_REDIRECTS) return { ok: false, kind: 'too_many_redirects' };
      const hopCheck = checkRedirect(location, current);
      if (!hopCheck.ok) return { ok: false, kind: 'blocked', reason: hopCheck.reason };
      current = hopCheck.url.href;
    }
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
  let html;
  try {
    html = await res.text();
  } catch (err) {
    return { ok: false, kind: 'parse', error: err.message };
  }
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
  return { ok: true, text };
}
