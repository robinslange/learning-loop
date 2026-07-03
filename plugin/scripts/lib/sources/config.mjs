import { getConfig } from '../config.mjs';

export const SLOT_DEFAULTS = Object.freeze({
  web_search: 'brave',
  fetch: 'raw',
});

export function loadSourcesConfig({ getConfigFn = getConfig } = {}) {
  const s = getConfigFn().sources || {};
  const out = { providers: s.providers || {} };
  for (const [slot, def] of Object.entries(SLOT_DEFAULTS)) {
    out[slot] = s[slot] || def;
  }
  return out;
}
