import { warnOnce } from '../warn-once.mjs';
import { isOffline } from '../env.mjs';

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

export async function fetchPageText(url) {
  if (isOffline()) return { ok: false, kind: 'offline' };
  let res;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; learning-loop/1.0)' },
      signal: AbortSignal.timeout(15000),
    });
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
