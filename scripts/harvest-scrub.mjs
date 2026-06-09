// scripts/harvest-scrub.mjs : mechanical IP scrub for harvest.
// denylist hit => hard block (fail closed). tripwire hit => flag only (review aid).
// LLM review (in SKILL.md) operates on `clean` and may drop more, never un-block.
// Deny terms match on WORD BOUNDARIES and are regex-escaped, so "ai" does not
// block "maintainer" and "foster.co.nz" matches dots literally.

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {{path:string,text:string}[]} notes
 * @param {{denylist:string[], tripwirePatterns:string[]}} opts
 * @returns {{blocked:{path:string,hits:string[]}[], tripwire:{path:string,hits:string[]}[], clean:{path:string,text:string}[]}}
 */
export function scrubNotes(notes, opts) {
  const denyRes = (opts.denylist || [])
    .filter((d) => typeof d === 'string' && d.trim())
    .map((d) => ({ term: d, re: new RegExp(`(?<![\\w-])${escapeRegExp(d)}(?![\\w-])`, 'i') }));
  const tripRes = (opts.tripwirePatterns || [])
    .map((p) => { try { return new RegExp(p, 'g'); } catch { return null; } })
    .filter(Boolean);
  const blocked = [];
  const tripwire = [];
  const clean = [];
  for (const note of notes) {
    const denyHits = denyRes.filter((d) => d.re.test(note.text)).map((d) => d.term);
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
  // CLI: harvest-scrub.mjs <denylistFile> <pluginData> <note-path...>  -> JSON report.
  // The hard gate = hand-listed deny terms (from the file) MERGED with mechanically
  // derived instance facts (peer ids, own pubkey, email domains) via deriveInstanceFacts.
  const { readFileSync } = await import('node:fs');
  const { deriveInstanceFacts } = await import('./lib/instance-facts.mjs');
  const { getConfig } = await import('./lib/config.mjs');
  const [denyFile, pluginData, ...paths] = process.argv.slice(2);
  const fileTerms = denyFile
    ? readFileSync(denyFile, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'))
    : [];
  let cfg = {};
  try { cfg = getConfig(); } catch { cfg = {}; }
  const facts = pluginData ? deriveInstanceFacts(pluginData, cfg) : [];
  const denylist = [...new Set([...fileTerms, ...facts])];
  const TRIPWIRES = ['https?://\\S+', '\\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\\b'];
  const notes = paths.map((p) => ({ path: p, text: readFileSync(p, 'utf8') }));
  console.log(JSON.stringify(scrubNotes(notes, { denylist, tripwirePatterns: TRIPWIRES }), null, 2));
}
