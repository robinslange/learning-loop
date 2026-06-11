import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

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
    writeFileSync(p, JSON.stringify(result, null, 2));
    return true;
  } catch {
    return false;
  }
}

export function isCacheStale(cache) {
  if (!cache || !cache.ts) return true;
  const age = Date.now() - new Date(cache.ts).getTime();
  return age > CACHE_TTL_MS;
}
