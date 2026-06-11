// scripts/federation-active.mjs : is this instance federated? (mechanical guard)
import { safeLoad } from './lib/safe-load.mjs';
import { FEDERATION_PATHS } from './lib/paths.mjs';

/**
 * @param {string} pluginData  plugin-data dir
 * @returns {boolean} true if a federation config with an identity pubkey exists
 */
export function isFederationActive(pluginData) {
  if (!pluginData) return false;
  const { value: parsed } = safeLoad(FEDERATION_PATHS.config(pluginData), { fallback: null });
  return Boolean(parsed && parsed.identity && parsed.identity.pubkey);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { getPluginData } = await import('./lib/config.mjs');
  const pd = process.argv[2] || getPluginData();
  const active = isFederationActive(pd);
  if (active) console.log('FEDERATED');
  else console.log('not-federated');
  process.exit(active ? 0 : 1);
}
