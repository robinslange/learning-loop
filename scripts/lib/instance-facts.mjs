// scripts/lib/instance-facts.mjs : mechanically derive IP-sensitive terms present
// on this instance, to merge into the harvest hard-gate denylist.
import { readdirSync, existsSync } from 'node:fs';
import { FEDERATION_PATHS } from './paths.mjs';
import { safeLoad } from './safe-load.mjs';

/**
 * @param {string} pluginData
 * @param {{email_domains?: string[] | string}} [config]  the loaded learning-loop config
 * @returns {string[]} deny terms (peer ids, own pubkey, email domains)
 */
export function deriveInstanceFacts(pluginData, config = {}) {
  const facts = new Set();

  // Federation peer directory names are peer ids.
  const peersDir = FEDERATION_PATHS.peersDir(pluginData);
  if (existsSync(peersDir)) {
    for (const e of readdirSync(peersDir, { withFileTypes: true })) {
      if (e.isDirectory()) facts.add(e.name);
    }
  }

  // Own federation pubkey.
  const fedConfigPath = FEDERATION_PATHS.config(pluginData);
  const { value: parsed, error: fedErr } = safeLoad(fedConfigPath, { fallback: null });
  if (fedErr && fedErr !== 'enoent' && fedErr !== 'no path') {
    // Fail CLOSED: an unreadable federation config means the own-pubkey deny
    // term silently vanishes from the harvest gate.
    throw new Error(`federation config unreadable at ${fedConfigPath}: ${fedErr}`);
  }
  if (parsed?.identity?.pubkey) facts.add(parsed.identity.pubkey);

  // Configured email domains (operator-set in config). A bare string is the
  // natural single-domain typo — coerce it so it is added whole, never iterated
  // character-by-character (that would shred "acme.com" into ['a','c','m',...]
  // and silently un-protect the company name: a fail-OPEN of the hard gate).
  // Any other non-array shape (object, number) cannot mean a domain — fail CLOSED
  // by throwing so the caller surfaces it rather than running with no protection.
  const domains = config.email_domains;
  if (domains != null) {
    const list = typeof domains === 'string' ? [domains] : domains;
    if (!Array.isArray(list)) {
      throw new TypeError(
        `config.email_domains must be an array of domains or a single domain string, got ${typeof domains}`,
      );
    }
    for (const d of list) {
      if (typeof d === 'string' && d.trim()) facts.add(d.trim());
    }
  }

  return [...facts];
}
