// scripts/lib/instance-facts.mjs : mechanically derive IP-sensitive terms present
// on this instance, to merge into the harvest hard-gate denylist.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { FEDERATION_PATHS } from './paths.mjs';

/**
 * @param {string} pluginData
 * @param {{email_domains?: string[]}} [config]  the loaded learning-loop config
 * @returns {string[]} deny terms (peer ids, own pubkey, email domains)
 */
export function deriveInstanceFacts(pluginData, config = {}) {
  const facts = new Set();

  // Federation peer directory names are peer ids.
  const peersDir = FEDERATION_PATHS.peersDir(pluginData);
  try {
    for (const e of readdirSync(peersDir, { withFileTypes: true })) {
      if (e.isDirectory()) facts.add(e.name);
    }
  } catch {
    /* no peers dir — fine */
  }

  // Own federation pubkey.
  const cfgPath = FEDERATION_PATHS.config(pluginData);
  if (existsSync(cfgPath)) {
    try {
      const parsed = JSON.parse(readFileSync(cfgPath, 'utf8'));
      if (parsed?.identity?.pubkey) facts.add(parsed.identity.pubkey);
    } catch {
      /* unparseable — skip */
    }
  }

  // Configured email domains (operator-set in config).
  for (const d of config.email_domains || []) {
    if (typeof d === 'string' && d.trim()) facts.add(d.trim());
  }

  return [...facts];
}
