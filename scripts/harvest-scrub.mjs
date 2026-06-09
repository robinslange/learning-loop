// scripts/harvest-scrub.mjs : mechanical IP scrub for harvest.
// denylist hit => hard block (fail closed). tripwire hit => flag only (review aid).
// LLM review (in SKILL.md) operates on `clean` and may drop more, never un-block.
// Deny terms match via the shared word-boundary matcher (lib/deny-match.mjs), so
// "ai" does not block "maintainer", "foster.co.nz" matches dots literally, and
// "-"/"_" count as boundaries so "acme" matches "acme-registry"/"acme_registry".
// Both the note body AND the note's filename basename are scanned.

import { basename } from 'node:path';
import { denyTermRegExp } from './lib/deny-match.mjs';

/**
 * @param {{path:string,text:string}[]} notes
 * @param {{denylist:string[], tripwirePatterns:string[]}} opts
 * @returns {{blocked:{path:string,hits:string[]}[], tripwire:{path:string,hits:string[]}[], clean:{path:string,text:string}[]}}
 */
export function scrubNotes(notes, opts) {
  const denyRes = (opts.denylist || [])
    .filter((d) => typeof d === 'string' && d.trim())
    .map((d) => ({ term: d, re: denyTermRegExp(d) }));
  const tripRes = (opts.tripwirePatterns || [])
    .map((p) => { try { return new RegExp(p, 'g'); } catch { return null; } })
    .filter(Boolean);
  const blocked = [];
  const tripwire = [];
  const clean = [];
  for (const note of notes) {
    const haystacks = [note.text, basename(note.path || '')];
    const denyHits = denyRes.filter((d) => haystacks.some((h) => d.re.test(h))).map((d) => d.term);
    if (denyHits.length > 0) {
      blocked.push({ path: note.path, hits: denyHits });
      continue; // block wins; do not add to clean
    }
    const tripHits = [];
    for (const re of tripRes) {
      const m = note.text.match(re);
      if (m) tripHits.push(...m);
    }
    if (tripHits.length > 0) tripwire.push({ path: note.path, hits: tripHits });
    clean.push(note); // passes mechanical gate -> goes to LLM/human review
  }
  return { blocked, tripwire, clean };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // CLI: harvest-scrub.mjs <denylistFile> <pluginData> [note-path...]  -> JSON report.
  // Note paths come from argv (small sets) OR, when none are passed, from stdin
  // (one per line) so a large bulk-marked set never exceeds ARG_MAX.
  // The hard gate = hand-listed deny terms (from the file) MERGED with mechanically
  // derived instance facts (peer ids, own pubkey, email domains) via deriveInstanceFacts.
  const { readFileSync } = await import('node:fs');
  const { deriveInstanceFacts } = await import('./lib/instance-facts.mjs');
  const { getConfig } = await import('./lib/config.mjs');
  const [denyFile, pluginData, ...argvPaths] = process.argv.slice(2);
  const paths = argvPaths.length > 0
    ? argvPaths
    : readFileSync(0, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const fileTerms = denyFile
    ? readFileSync(denyFile, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'))
    : [];
  let cfg = {};
  try { cfg = getConfig(); } catch { cfg = {}; }
  // Fail CLOSED: a malformed config (e.g. email_domains as an object) must not
  // crash with an opaque stack trace and no report — that hides which gate failed.
  // Surface a clear operator error and exit non-zero so nothing is treated as clean.
  let facts = [];
  if (pluginData) {
    try {
      facts = deriveInstanceFacts(pluginData, cfg);
    } catch (err) {
      process.stderr.write(`[harvest-scrub] cannot derive instance facts: ${err.message}\n`);
      process.exit(1);
    }
  }
  const denylist = [...new Set([...fileTerms, ...facts])];
  const TRIPWIRES = ['https?://\\S+', '\\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\\b'];
  const notes = paths.map((p) => ({ path: p, text: readFileSync(p, 'utf8') }));
  console.log(JSON.stringify(scrubNotes(notes, { denylist, tripwirePatterns: TRIPWIRES }), null, 2));
}
