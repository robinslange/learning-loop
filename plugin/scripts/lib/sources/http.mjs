import { isOffline } from '../env.mjs';
import { fetchGuarded } from './url-guard.mjs';

export const RATE_LIMIT_MS = 500;
const TIMEOUT_MS = 10000;

export async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// The network leaf behind all ~13 source adapters. Hosts are hardcoded literals
// today and only the query string varies, but an adapter that builds a URL from
// note content would inherit whatever guard lives here — so it drives the same
// redirect-checked loop as web-fetch.mjs instead of calling fetch() raw.
async function fetchOk(url) {
  if (isOffline()) return null;
  const guarded = await fetchGuarded(url, (hopUrl) =>
    fetch(hopUrl, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) }),
  );
  return guarded.ok && guarded.res.ok ? guarded.res : null;
}

export async function fetchJSON(url) {
  const res = await fetchOk(url);
  return res ? res.json() : null;
}

export async function fetchXML(url) {
  const res = await fetchOk(url);
  return res ? res.text() : null;
}
