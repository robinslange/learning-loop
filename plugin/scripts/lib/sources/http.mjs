import { isOffline } from '../env.mjs';

export const RATE_LIMIT_MS = 500;

export async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function fetchJSON(url) {
  if (isOffline()) return null;
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

export async function fetchXML(url) {
  if (isOffline()) return null;
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.text();
}
