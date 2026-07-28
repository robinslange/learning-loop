// lib/sources/url-guard.mjs : SSRF guard for every outbound fetch.
//
// One validator, used by BOTH network entry points — the source gateway
// (bin/source-gateway.mjs, the only egress path once web-guard.js denies
// WebFetch/WebSearch) and web-fetch.mjs (which fetches URLs scraped out of
// note bodies). A URL reaching either can be attacker-authored: note content
// arrives via /literature <URL>, /ingest repo, and clipped pages.
//
// Scheme allowlist + literal-IP range check. DNS rebinding is NOT defended
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
  // IPv4-mapped (::ffff:127.0.0.1) — check the embedded v4.
  const m = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (m) {
    const v4 = parseIPv4(m[1]);
    return v4 ? isPrivateIPv4(v4) : true;
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
  const host = u.hostname.toLowerCase();
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
