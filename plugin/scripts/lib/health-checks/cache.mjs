import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pluginVersion } from '../plugin-meta.mjs';

export const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const CACHE_FILE = 'last-health.json';

export function readHealthCache({ pluginData } = {}) {
  if (!pluginData) return null;
  const p = join(pluginData, CACHE_FILE);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

export function writeHealthCache({ pluginData, result } = {}) {
  if (!pluginData) return false;
  const p = join(pluginData, CACHE_FILE);
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ ...result, version: pluginVersion() }, null, 2));
    return true;
  } catch {
    return false;
  }
}

// Staleness is two questions, not one. Age answers "have the facts moved?";
// version answers "was this prose written by the code that ships today?". The
// cache stores rendered advice, so a fix that corrects what a check SAYS
// leaves every existing cache serving the retracted wording until its TTL
// expires. A version mismatch is a miss, and a cache written before stamping
// existed has no version to match, so it is one too.
export function isCacheStale(cache, version = pluginVersion()) {
  if (!cache || !cache.ts) return true;
  if (cache.version !== version) return true;
  const age = Date.now() - new Date(cache.ts).getTime();
  return age > CACHE_TTL_MS;
}
