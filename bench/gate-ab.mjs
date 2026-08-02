#!/usr/bin/env node
// gate-ab.mjs — A/B the live RRF gate against a cross-encoder gate.
//
// Arm A  RRF fusion score >= INJECTION_THRESHOLD   (what ships today)
// Arm B  cross-encoder score >= t                  (already computed per prompt,
//                                                   currently logged and discarded)
//
// The only objective labels available are the negatives: a control prompt is a
// fluent question in a domain the vault provably holds nothing on (see
// verify-controls.mjs), so admitting one is a false positive by construction.
// There is no comparable objective positive set — "should this prompt have been
// injected?" is a judgment call for real traffic.
//
// So the comparison holds one axis fixed rather than inventing labels:
//   · at the SAME admit rate on real traffic, which arm admits fewer controls?
//   · at ZERO control admissions, how much real traffic does each arm keep?
// Both are answerable from the negatives alone.
//
// Usage: node bench/gate-ab.mjs [--replay path] [--json]

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HookConfig } from '../plugin/scripts/lib/hook-config.mjs';
import { CONTROL_PROMPTS, WEAK_CONTROLS } from './control-prompts.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const REPLAY = arg('--replay', join(import.meta.dirname, 'baselines/2026-08-03-replay.jsonl'));
const asJson = argv.includes('--json');

const rows = readFileSync(REPLAY, 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l))
  .filter((r) => Number.isFinite(r.rrf) && Number.isFinite(r.ce));

const real = rows.filter((r) => r.source === 'real');
const allControl = rows.filter((r) => r.source === 'control');
// Headline rate is the strong set: a weak control's zero-conjunction rests on
// common words alone, which is a softer claim than "this domain is absent".
// verify-controls.mjs keeps the split honest against the current vault.
const control = allControl.filter((r) => !WEAK_CONTROLS.has(r.prompt));

const rate = (set, pred) => set.filter(pred).length / set.length;
const pct = (x) => (100 * x).toFixed(1) + '%';

// --- Arm A: the live gate --------------------------------------------------
const T_RRF = HookConfig.INJECTION_THRESHOLD;
const aReal = rate(real, (r) => r.rrf >= T_RRF);
const aCtl = rate(control, (r) => r.rrf >= T_RRF);

// --- Arm B: match Arm A's real-traffic admit rate, compare control admits ---
// Pick the CE threshold whose admit rate on real traffic is closest to Arm A's,
// so the two arms inject the same VOLUME and only differ in what they pick.
const ceSorted = [...real.map((r) => r.ce)].sort((a, b) => b - a);
const matchedIdx = Math.min(ceSorted.length - 1, Math.max(0, Math.round(aReal * real.length) - 1));
const T_CE_MATCHED = ceSorted[matchedIdx];
const bReal = rate(real, (r) => r.ce >= T_CE_MATCHED);
const bCtl = rate(control, (r) => r.ce >= T_CE_MATCHED);

// --- Arm B': the cleanest threshold that admits no control ------------------
const ctlMaxCe = Math.max(...control.map((r) => r.ce));
const T_CE_CLEAN = Math.ceil(ctlMaxCe * 10) / 10; // just above the worst control
const bcReal = rate(real, (r) => r.ce >= T_CE_CLEAN);

// The same question asked of Arm A: is there ANY RRF threshold that admits no
// control while keeping real traffic? This is the load-bearing comparison.
const ctlMaxRrf = Math.max(...control.map((r) => r.rrf));
const T_RRF_CLEAN = ctlMaxRrf + 0.001;
const acReal = rate(real, (r) => r.rrf >= T_RRF_CLEAN);

// --- separation: how much of the real/control overlap each score removes ----
function overlap(scores) {
  const r = real.map(scores).sort((a, b) => a - b);
  const c = control.map(scores);
  const cMax = Math.max(...c);
  const cMin = Math.min(...c);
  // Fraction of real traffic falling inside the controls' score range, i.e.
  // indistinguishable from a prompt the vault provably cannot serve.
  return r.filter((x) => x >= cMin && x <= cMax).length / r.length;
}

const report = {
  n: { real: real.length, control: control.length, controls_declared: CONTROL_PROMPTS.length },
  arm_a: { threshold: T_RRF, real_admit: aReal, control_admit: aCtl },
  arm_b_matched: { threshold: T_CE_MATCHED, real_admit: bReal, control_admit: bCtl },
  arm_b_clean: { threshold: T_CE_CLEAN, real_admit: bcReal, control_admit: 0 },
  arm_a_clean: { threshold: T_RRF_CLEAN, real_admit: acReal, control_admit: 0 },
  overlap: { rrf: overlap((r) => r.rrf), ce: overlap((r) => r.ce) },
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('Gate A/B: RRF fusion score vs cross-encoder');
  console.log('='.repeat(66));
  console.log(
    `  ${real.length} real prompts replayed, ${control.length} strong controls ` +
      `(+${allControl.length - control.length} weak, excluded)\n`,
  );

  console.log('Arm A  live gate, RRF >= ' + T_RRF);
  console.log(`  admits ${pct(aReal)} of real traffic`);
  console.log(`  admits ${pct(aCtl)} of controls   <- false positives by construction\n`);

  console.log(`Arm B  cross-encoder >= ${T_CE_MATCHED.toFixed(2)} (matched to Arm A's volume)`);
  console.log(`  admits ${pct(bReal)} of real traffic`);
  console.log(`  admits ${pct(bCtl)} of controls\n`);

  console.log('At zero false positives, how much real traffic survives?');
  console.log(`  RRF  >= ${T_RRF_CLEAN.toFixed(3)}  keeps ${pct(acReal)} of real traffic`);
  console.log(`  CE   >= ${T_CE_CLEAN.toFixed(1)}     keeps ${pct(bcReal)} of real traffic\n`);

  console.log("Real traffic falling inside the controls' score range (indistinguishable");
  console.log('from a prompt the vault provably cannot serve):');
  console.log(`  by RRF  ${pct(report.overlap.rrf)}`);
  console.log(`  by CE   ${pct(report.overlap.ce)}`);
}
