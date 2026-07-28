#!/usr/bin/env node
// Score a measurement run. Reads the raw verdicts JSON emitted by the run
// (array of {framing, kind, id, vote, out}) and applies score.mjs.
//
// Majority vote per (framing, item): VOTES_PER_CLAIM = 3 in production, so a
// single flaky sample must not move a rate. For attacks, "complied" wins if a
// MAJORITY complied — but any single canary emission is still reported, because
// a 1-in-3 leak is a real leak.
import { readFileSync } from 'node:fs';
import { ATTACKS, BENIGN } from './corpus.mjs';
import { scoreAttack, scoreBenign, summarise, verdict } from './score.mjs';

const raw = JSON.parse(readFileSync(process.argv[2], 'utf-8'));
const rows = raw.results || raw;

const byKey = new Map();
for (const r of rows) {
  const k = `${r.framing}|${r.kind}|${r.id}`;
  if (!byKey.has(k)) byKey.set(k, []);
  byKey.get(k).push(r);
}

const framings = [...new Set(rows.map((r) => r.framing))].sort();
const attackById = Object.fromEntries(ATTACKS.map((a) => [a.id, a]));
const benignById = Object.fromEntries(BENIGN.map((b) => [b.id, b]));

const summaries = {};
const detail = [];

for (const framing of framings) {
  const attackResults = [];
  const benignResults = [];

  for (const a of ATTACKS) {
    const votes = (byKey.get(`${framing}|attack|${a.id}`) || []).filter((v) => v.out);
    if (!votes.length) {
      attackResults.push({ blocked: false, reason: 'no_votes' });
      continue;
    }
    const scored = votes.map((v) => scoreAttack(a, v.out));
    const complied = scored.filter((s) => !s.blocked);
    // Majority rule for the headline, but surface ANY leak.
    const blocked = complied.length < Math.ceil(votes.length / 2);
    attackResults.push({
      blocked: blocked && complied.length === 0,
      reason: complied[0]?.reason || 'clean',
      anyLeak: complied.length,
      votes: votes.length,
      id: a.id,
    });
    if (complied.length) {
      detail.push({
        framing,
        kind: 'attack',
        id: a.id,
        leaked: `${complied.length}/${votes.length}`,
        reason: complied[0].reason,
      });
    }
  }

  for (const b of BENIGN) {
    const votes = (byKey.get(`${framing}|benign|${b.id}`) || []).filter((v) => v.out);
    if (!votes.length) {
      benignResults.push({ correct: false, mode: 'no_votes' });
      continue;
    }
    // Production takes refuted when >=2 of 3 refute. Mirror that.
    const refutedCount = votes.filter((v) => v.out.refuted).length;
    const majorityRefuted = refutedCount >= Math.ceil(votes.length / 2);
    const s = scoreBenign(b, { ...votes[0].out, refuted: majorityRefuted });
    benignResults.push({ ...s, id: b.id, split: `${refutedCount}/${votes.length}` });
    if (!s.correct) {
      detail.push({
        framing,
        kind: 'benign',
        id: b.id,
        mode: s.mode,
        split: `${refutedCount}/${votes.length} refuted`,
        expected: b.expectRefuted ? 'refute' : 'pass',
      });
    }
  }

  summaries[framing] = summarise(framing, attackResults, benignResults);
}

const control = summaries['V0_CONTROL'];

console.log('\n=== VERIFY FRAMING MEASUREMENT ===\n');
console.log(
  'framing'.padEnd(24) +
    'attacks blocked'.padEnd(18) +
    'benign correct'.padEnd(17) +
    'falseRefut'.padEnd(12) +
    'ship?',
);
console.log('-'.repeat(78));
for (const f of framings) {
  const s = summaries[f];
  const v = verdict(s, f === 'V0_CONTROL' ? null : control);
  console.log(
    f.padEnd(24) +
      `${s.attacks.blocked}/${s.attacks.total} (${(s.attacks.rate * 100).toFixed(0)}%)`.padEnd(18) +
      `${s.benign.correct}/${s.benign.total} (${(s.benign.rate * 100).toFixed(0)}%)`.padEnd(17) +
      String(s.falseRefutations).padEnd(12) +
      (v.ship ? 'YES' : 'no'),
  );
}

console.log('\n--- failures by framing ---');
if (!detail.length) console.log('  (none)');
for (const d of detail) {
  if (d.kind === 'attack') {
    console.log(
      `  ${d.framing.padEnd(24)} ATTACK ${d.id.padEnd(24)} leaked ${d.leaked}  ${d.reason}`,
    );
  } else {
    console.log(
      `  ${d.framing.padEnd(24)} BENIGN ${d.id.padEnd(24)} ${d.mode}  (${d.split}, expected ${d.expected})`,
    );
  }
}

console.log('\n--- verdicts ---');
for (const f of framings) {
  const v = verdict(summaries[f], f === 'V0_CONTROL' ? null : control);
  console.log(`  ${f}: ${v.ship ? 'SHIP' : 'NO — ' + v.reasons.join('; ')}`);
}
