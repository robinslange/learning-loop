// scripts/harvest-scrub.mjs : mechanical IP scrub for harvest.
// denylist hit => hard block (fail closed). tripwire hit => flag only (review aid).
// LLM review (in SKILL.md) operates on `clean` and may drop more, never un-block.
// Deny terms match via the shared word-boundary matcher (lib/deny-match.mjs), so
// "ai" does not block "maintainer", "foster.co.nz" matches dots literally, and
// "-"/"_" count as boundaries so "acme" matches "acme-registry"/"acme_registry".
// Both the note body AND the note's filename basename are scanned.

import { basename } from 'node:path';
import { denyTermRegExp } from './lib/deny-match.mjs';
import { SECRET_PATTERNS, EMAIL_RE } from './lib/secret-patterns.mjs';
import { pathToFileURL } from 'node:url';

// Credential-shaped content and bare email addresses are always a hard block,
// not just a tripwire — this is the same net inject.mjs redacts with, applied
// here as BLOCK rather than [REDACTED] since harvest candidates that contain a
// live secret must never reach clean/review at all.
const SECRET_DENY_RES = [
  ...SECRET_PATTERNS.map(({ kind, re }) => ({ term: `secret:${kind}`, re })),
  { term: 'secret:email', re: EMAIL_RE },
];

/**
 * @param {{path:string,text:string}[]} notes
 * @param {{denylist:string[], tripwirePatterns:string[]}} opts
 * @returns {{blocked:{path:string,hits:string[]}[], tripwire:{path:string,hits:string[]}[], clean:{path:string,text:string}[]}}
 */
export function scrubNotes(notes, opts) {
  const denyRes = (opts.denylist || [])
    .map((d) => {
      if (typeof d === 'number') return String(d);
      if (typeof d !== 'string') {
        throw new TypeError(`deny term must be a string, got ${typeof d}: ${JSON.stringify(d)}`);
      }
      return d;
    })
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => ({ term: d, re: denyTermRegExp(d) }))
    .concat(SECRET_DENY_RES);
  const tripRes = (opts.tripwirePatterns || [])
    .map((p) => {
      try {
        return new RegExp(p, 'g');
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const blocked = [];
  const tripwire = [];
  const clean = [];
  for (const note of notes) {
    const haystacks = [note.text, basename(note.path || '')];
    const denyHits = denyRes
      .filter((d) =>
        haystacks.some((h) => {
          d.re.lastIndex = 0; // d.re may be a shared /g regex (SECRET_DENY_RES); reset before each test
          return d.re.test(h);
        }),
      )
      .map((d) => d.term);
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // CLI: harvest-scrub.mjs <denylistFile> <pluginData> [note-path...]  -> JSON report.
  // Note paths come from argv (small sets) OR, when none are passed, from stdin
  // (one per line) so a large bulk-marked set never exceeds ARG_MAX.
  // The hard gate = hand-listed deny terms (from the file) MERGED with mechanically
  // derived instance facts (peer ids, own pubkey, email domains) via deriveInstanceFacts.
  const { readFileSync } = await import('node:fs');
  const { deriveInstanceFacts } = await import('./lib/instance-facts.mjs');
  const { getConfigStrict } = await import('./lib/config.mjs');
  const [denyFile, pluginData, ...argvPaths] = process.argv.slice(2);
  const paths =
    argvPaths.length > 0
      ? argvPaths
      : readFileSync(0, 'utf8')
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean);
  const fileTerms = denyFile
    ? readFileSync(denyFile, 'utf8')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith('#'))
    : [];
  // Fail CLOSED: an unreadable config silently dropping email_domains deny
  // terms is exactly the gate-weakening this CLI exists to prevent.
  let cfg;
  try {
    cfg = getConfigStrict();
  } catch (err) {
    process.stderr.write(`[harvest-scrub] ${err.message}\n`);
    process.exit(1);
  }
  // Likewise a malformed config value (e.g. email_domains as an object): surface
  // a clear operator error and exit non-zero so nothing is treated as clean.
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
  console.log(
    JSON.stringify(scrubNotes(notes, { denylist, tripwirePatterns: TRIPWIRES }), null, 2),
  );
}
