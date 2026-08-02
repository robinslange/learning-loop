#!/usr/bin/env node
// verify-controls.mjs — prove the control prompts are actually controls.
//
// A control only means anything if the vault genuinely holds nothing on its
// domain. This checks each control's distinctive terms against the FTS index
// directly (not through the retrieval funnel, which always returns its nearest
// neighbours whether or not they are relevant). A control whose terms match a
// real note has stopped being a control and must be replaced.
//
// Usage: node bench/verify-controls.mjs [--db path]

import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { CONTROL_PROMPTS, WEAK_CONTROLS } from './control-prompts.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const DB = arg('--db', join(process.env.HOME, 'brain/brain/.vault-search/vault-index.db'));

// A single shared word proves nothing: "ship" appears in 621 notes about
// shipping code, "test" in 1491, and neither means the vault covers marine
// engineering. The domain is covered only if some note matches the
// CONJUNCTION of the prompt's rarest content terms. Rarity is measured against
// this vault, so the check adapts as the vault grows rather than depending on
// a hand-tuned stopword list.
const GENERIC =
  /^(a|an|the|how|do|does|did|what|which|who|when|where|why|is|are|was|were|be|for|from|with|into|onto|out|over|under|then|all|any|both|each|some|such|not|only|same|than|too|very|can|will|just|should|now|to|of|in|on|at|by|and|or|if|but|you|your|best|correct|safe|long|normal|use|used|using)$/;

function ftsCount(expr) {
  try {
    const out = execFileSync(
      'sqlite3',
      [DB, `SELECT count(*) FROM notes_fts WHERE notes_fts MATCH '${expr.replace(/'/g, "''")}'`],
      { encoding: 'utf8' },
    );
    return Number(out.trim()) || 0;
  } catch {
    return -1; // table shape differs; reported rather than silently passed
  }
}

// How many distinct terms must co-occur before we call the domain "covered".
const CONJUNCTION_SIZE = 3;

// The index tokenizes with a porter stemmer, so a per-term count is a count of
// the STEM: "escapement" stems to "escap" and matches every note about
// escaping a string. Per-term counts are therefore an upper bound and are
// shown for audit only; the pass/fail criterion is the conjunction.
//
// A control is only a hard negative if at least one of its terms is genuinely
// absent from the vault. If every term is common, a zero conjunction just
// means those common words never co-occur, which is a much weaker claim.
const RARE_ENOUGH = 2;

let failures = 0;
let weak = 0;
const computedWeak = new Set();
console.log("Control verification: no note may match the conjunction of a control's rarest stems");
console.log('(counts are stem counts under the porter tokenizer, shown for audit)\n');
for (const p of CONTROL_PROMPTS) {
  const terms = [
    ...new Set(
      p
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 3 && !GENERIC.test(w)),
    ),
  ];
  const ranked = terms
    .map((t) => [t, ftsCount(t)])
    .sort((a, b) => a[1] - b[1])
    .slice(0, CONJUNCTION_SIZE);
  const expr = ranked.map(([t]) => t).join(' AND ');
  const n = ftsCount(expr);
  const shown = ranked.map(([t, c]) => `${t}(${c})`).join(' ');
  if (n > 0) {
    failures++;
    console.log(`  COVERED  ${p}`);
    console.log(`             ${expr} -> ${n} notes`);
  } else if ((ranked[0]?.[1] ?? Infinity) > RARE_ENOUGH) {
    weak++;
    computedWeak.add(p);
    console.log(`  WEAK     ${shown}  <- no term is vault-absent; soft negative`);
  } else {
    console.log(`  clean    ${shown}`);
  }
}
const strong = CONTROL_PROMPTS.length - failures - weak;
console.log(
  `\n${strong} strong, ${weak} weak, ${failures} covered (of ${CONTROL_PROMPTS.length}).`,
);

// gate-ab.mjs reports the headline false-positive rate on the strong set, so
// the declared split has to match what the vault actually says today. Drifting
// apart would silently move the number without anyone editing it.
const declared = [...WEAK_CONTROLS].sort();
const computed = [...computedWeak].sort();
if (JSON.stringify(declared) !== JSON.stringify(computed)) {
  failures++;
  console.log('\nWEAK_CONTROLS in control-prompts.mjs is stale.');
  console.log(`  declared: ${JSON.stringify(declared, null, 2)}`);
  console.log(`  computed: ${JSON.stringify(computed, null, 2)}`);
}
process.exit(failures === 0 ? 0 : 1);
