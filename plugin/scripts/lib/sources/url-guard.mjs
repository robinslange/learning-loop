// lib/sources/url-guard.mjs : SSRF guard for every outbound fetch.
//
// One validator, used by BOTH network entry points — the source gateway
// (bin/source-gateway.mjs, the only egress path once web-guard.js denies
// WebFetch/WebSearch) and web-fetch.mjs (which fetches URLs scraped out of
// note bodies). A URL reaching either can be attacker-authored: note content
// arrives via /literature <URL>, /ingest repo, and clipped pages.
//
// Scheme allowlist + literal-IP range check, applied to the origin AND to every
// redirect hop via fetchGuarded — validating only the origin is not a guard, and
// both callers now drive the same loop. DNS rebinding is NOT defended
// here: resolving the host and checking the address still races the kernel's
// own resolution at connect time. The honest mitigation is that fetch results
// are treated as untrusted data downstream, not that the host is proven safe.
// What this DOES stop: direct http://127.0.0.1:port/, IMDS at 169.254.169.254,
// RFC1918 targets, file:/gopher:/ftp: scheme abuse, and — via checkRedirect —
// a public host 302-ing into any of those.

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

// Parse dotted-quad IPv4, else null. Rejects the octal/hex/integer forms
// (0177.0.0.1, 0x7f000001, 2130706433) by only accepting plain decimal —
// those forms are then caught by the "not a literal IP" path, where the
// hostname fails to match and is treated as a name, not silently allowed.
function parseIPv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return null;
  if (m.slice(1).some((s) => s.length > 1 && s[0] === '0')) return null; // no octal
  return o;
}

function isPrivateIPv4([a, b]) {
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // loopback
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 169 && b === 254) return true; // link-local + cloud IMDS
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateIPv6(host) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === '::1' || h === '::') return true;
  if (h.startsWith('fc') || h.startsWith('fd')) return true; // unique-local
  if (h.startsWith('fe80')) return true; // link-local
  // IPv4-mapped. Both spellings are the SAME address and must not be two cases:
  // new URL() rewrites '[::ffff:127.0.0.1]' to its hex form '[::ffff:7f00:1]', so
  // a guard matching only the dotted-quad spelling passes loopback and IMDS
  // straight through (executed: fetch('http://[::ffff:7f00:1]:p/') reaches
  // 127.0.0.1). Pull the embedded v4 out of whichever form arrived, then apply
  // the one v4 rule.
  const mapped = /^::ffff:(.+)$/.exec(h);
  if (mapped) {
    const dotted = parseIPv4(mapped[1]);
    if (dotted) return isPrivateIPv4(dotted);
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(mapped[1]);
    if (hex) {
      const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16);
      return isPrivateIPv4([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
    }
    return true; // an ::ffff: form we cannot decompose is not one we should trust
  }
  return false;
}

/**
 * Validate a URL for outbound fetch.
 * @param {string} raw
 * @returns {{ok: true, url: URL} | {ok: false, reason: string}}
 */
export function checkFetchUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, reason: 'url_missing' };
  }
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: 'url_unparseable' };
  }
  if (!ALLOWED_SCHEMES.has(u.protocol)) {
    return { ok: false, reason: `scheme_not_allowed:${u.protocol.replace(':', '')}` };
  }
  // A trailing root dot is a legal, resolvable spelling of the same host, and
  // `new URL()` keeps it. Strip it before any name comparison or the exact
  // matches below miss `localhost.` and `metadata.google.internal.`.
  const host = u.hostname.toLowerCase().replace(/\.+$/, '');
  if (!host) return { ok: false, reason: 'url_no_host' };

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    return { ok: false, reason: 'host_loopback' };
  }
  const v4 = parseIPv4(host);
  if (v4) {
    if (isPrivateIPv4(v4)) return { ok: false, reason: 'host_private_ip' };
  } else if (host.includes(':') || host.startsWith('[')) {
    if (isPrivateIPv6(host)) return { ok: false, reason: 'host_private_ip' };
  }
  return { ok: true, url: u };
}

/**
 * Re-check a redirect target. Same rules; separated so callers reading
 * `redirect: 'manual'` can validate each hop and so the reason string
 * distinguishes a blocked hop from a blocked origin.
 * @param {string} location
 * @param {string|URL} base
 */
export function checkRedirect(location, base) {
  let abs;
  try {
    abs = new URL(location, base).href;
  } catch {
    return { ok: false, reason: 'redirect_unparseable' };
  }
  const r = checkFetchUrl(abs);
  return r.ok ? r : { ok: false, reason: `redirect_${r.reason}` };
}

export const MAX_REDIRECTS = 5;

/**
 * Fetch with every hop validated. `redirect: 'follow'` makes checkFetchUrl a
 * check on the ORIGIN only — a public host 302-ing into loopback or IMDS walks
 * straight past it (executed: a 302 into 127.0.0.1 returned the loopback body
 * through the source gateway). Guarding one entry point and not the other is
 * how that happened, so both now drive this loop.
 *
 * @param {string} url
 * @param {(u: string) => Promise<Response>} doFetch — issues ONE hop, must use
 *   `redirect: 'manual'`; owns its own headers/timeout.
 * @returns {Promise<{ok:true, res:Response, url:string} | {ok:false, reason:string}>}
 */
export async function fetchGuarded(url, doFetch) {
  const guard = checkFetchUrl(url);
  if (!guard.ok) return { ok: false, reason: guard.reason };
  let current = guard.url.href;
  for (let hop = 0; ; hop++) {
    const res = await doFetch(current);
    // Treat as a redirect only on an explicit 3xx WITH a Location header. A
    // response lacking status/headers (a stubbed fetch) is terminal, not a
    // redirect — defaulting the other way spins the loop.
    const status = typeof res.status === 'number' ? res.status : 200;
    if (status < 300 || status >= 400) return { ok: true, res, url: current };
    const location = res.headers?.get?.('location');
    if (!location) return { ok: true, res, url: current };
    if (hop >= MAX_REDIRECTS) return { ok: false, reason: 'too_many_redirects' };
    const hopCheck = checkRedirect(location, current);
    if (!hopCheck.ok) return { ok: false, reason: hopCheck.reason };
    current = hopCheck.url.href;
  }
}
