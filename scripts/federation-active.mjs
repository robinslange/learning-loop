// scripts/federation-active.mjs : is this instance federated? (mechanical guard)
import { readFileSync, existsSync } from 'node:fs';
import { FEDERATION_PATHS } from './lib/paths.mjs';

/**
 * @param {string} pluginData  plugin-data dir
 * @returns {boolean} true if a federation config with an identity pubkey exists
 */
export function isFederationActive(pluginData) {
  if (!pluginData) return false;
  const cfg = FEDERATION_PATHS.config(pluginData);
  if (!existsSync(cfg)) return false;
  try {
    const parsed = JSON.parse(readFileSync(cfg, 'utf8'));
    return Boolean(parsed && parsed.identity && parsed.identity.pubkey);
  } catch {
    return false;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { getPluginData } = await import('./lib/config.mjs');
  const pd = process.argv[2] || getPluginData();
  const active = isFederationActive(pd);
  if (active) console.log('FEDERATED');
  else console.log('not-federated');
  process.exit(active ? 0 : 1);
}
