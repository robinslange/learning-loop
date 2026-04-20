#!/usr/bin/env node
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function resolvePluginData() {
  const fromEnv = process.env.CLAUDE_PLUGIN_DATA;
  if (fromEnv) return fromEnv;
  console.error('CLAUDE_PLUGIN_DATA not set');
  process.exit(1);
}

const pd = resolvePluginData();
const dir = join(pd, 'retrieval');
if (!existsSync(dir)) {
  console.log('No retrieval directory yet. Run learning-loop in shadow mode first.');
  process.exit(0);
}

const files = readdirSync(dir).filter(f => f.startsWith('shadow-injection-') && f.endsWith('.jsonl'));
if (files.length === 0) {
  console.log('No shadow-injection logs found.');
  process.exit(0);
}

const entries = [];
for (const f of files) {
  for (const line of readFileSync(join(dir, f), 'utf8').trim().split('\n')) {
    if (!line) continue;
    try { entries.push(JSON.parse(line)); } catch {}
  }
}

const total = entries.length;
const fastPathSkips = entries.filter(e => e.gate?.fast_path_skip).length;

const vaultOk = entries.filter(e => !e.backends?.vault?.error);
const episodicOk = entries.filter(e => !e.backends?.episodic?.error);
const healthy = entries.filter(e =>
  !e.gate?.fast_path_skip &&
  !e.backends?.vault?.error &&
  !e.backends?.episodic?.error
);
const passed = entries.filter(e => e.gate?.passed === true);
const passedHealthy = healthy.filter(e => e.gate?.passed === true);

function percentiles(values) {
  if (values.length === 0) return { p50: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const p = (pct) => sorted[Math.floor((pct / 100) * (sorted.length - 1))];
  return { p50: p(50), p95: p(95), max: sorted[sorted.length - 1] };
}

function topErrors(list, key) {
  const counts = new Map();
  for (const e of list) {
    const err = e.backends?.[key]?.error;
    if (!err) continue;
    const short = String(err).slice(0, 60);
    counts.set(short, (counts.get(short) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
}

const vaultLat = healthy.map(e => e.backends?.vault?.latency_ms).filter(v => typeof v === 'number');
const episodicLat = healthy.map(e => e.backends?.episodic?.latency_ms).filter(v => typeof v === 'number');
const racedOut = healthy.filter(e => e.backends?.episodic?.raced_out).length;

const threshold = Number(process.env.LEARNING_LOOP_INJECTION_THRESHOLD || 0.35);

console.log('# Shadow injection review\n');
console.log(`Total entries: ${total}`);
console.log(`Fast-path skips: ${fastPathSkips} (${((fastPathSkips / total) * 100).toFixed(1)}%)`);

console.log('\n## Backend health');
const vaultHealthPct = (vaultOk.length / total) * 100;
const episodicHealthPct = (episodicOk.length / total) * 100;
console.log(`  Vault:    ${vaultOk.length} / ${total} healthy (${vaultHealthPct.toFixed(1)}%)`);
for (const [err, n] of topErrors(entries, 'vault')) console.log(`            ${n}x ${err}`);
console.log(`  Episodic: ${episodicOk.length} / ${total} healthy (${episodicHealthPct.toFixed(1)}%)`);
for (const [err, n] of topErrors(entries, 'episodic')) console.log(`            ${n}x ${err}`);
console.log(`  Both OK (excl. fast-path): ${healthy.length}`);

console.log('\n## Gate (threshold=' + threshold + ')');
console.log(`  Overall pass rate:  ${passed.length} / ${total} = ${((passed.length / total) * 100).toFixed(1)}%`);
if (healthy.length > 0) {
  const healthyPct = (passedHealthy.length / healthy.length) * 100;
  console.log(`  Healthy pass rate:  ${passedHealthy.length} / ${healthy.length} = ${healthyPct.toFixed(1)}%  <-- meaningful metric`);
}

if (healthy.length > 0) {
  const buckets = new Map();
  const step = 0.1;
  for (const e of healthy) {
    const s = Math.max(e.gate?.vault_top_score || 0, e.gate?.episodic_top_score || 0);
    const bucket = Math.min(Math.floor(s / step), 9);
    buckets.set(bucket, (buckets.get(bucket) || 0) + 1);
  }
  console.log('\n## Top score distribution (healthy entries)');
  for (let i = 0; i < 10; i++) {
    const n = buckets.get(i) || 0;
    if (n === 0) continue;
    const lo = (i * step).toFixed(1), hi = ((i + 1) * step).toFixed(1);
    const marker = (i * step) >= threshold ? '  [PASS]' : '';
    const bar = '#'.repeat(Math.min(40, Math.ceil(n / Math.max(1, healthy.length) * 40)));
    console.log(`  ${lo}-${hi}: ${String(n).padStart(4)}  ${bar}${marker}`);
  }
}

console.log('\n## Latency (healthy only)');
const vp = percentiles(vaultLat);
const ep = percentiles(episodicLat);
console.log(`  Vault:    p50=${vp.p50}ms p95=${vp.p95}ms max=${vp.max}ms`);
console.log(`  Episodic: p50=${ep.p50}ms p95=${ep.p95}ms max=${ep.max}ms`);
console.log(`  Episodic raced out: ${racedOut} / ${healthy.length}`);

console.log('\n## Verdict');
const healthyRate = total > 0 ? Math.min(vaultOk.length, episodicOk.length) / total : 0;
const passRate = healthy.length > 0 ? passedHealthy.length / healthy.length : 0;

if (healthyRate < 0.6 && total >= 50) {
  console.log(`  INFRASTRUCTURE: backend health <60% (${(healthyRate * 100).toFixed(0)}%).`);
  console.log(`  Fix backend errors above before drawing conclusions about the gate.`);
} else if (healthy.length < 100) {
  console.log(`  NOT READY: ${healthy.length} healthy entries (need >=100 for meaningful pass-rate).`);
} else if (passedHealthy.length >= 20 && passRate >= 0.05) {
  console.log(`  READY FOR REVIEW: ${passedHealthy.length} passed at ${(passRate * 100).toFixed(1)}% pass rate on healthy entries.`);
  console.log(`  Top 20 highest-confidence injections follow — judge quality before go-live.`);
  const ranked = [...passedHealthy]
    .sort((a, b) => Math.max(b.gate?.vault_top_score || 0, b.gate?.episodic_top_score || 0) -
                    Math.max(a.gate?.vault_top_score || 0, a.gate?.episodic_top_score || 0))
    .slice(0, 20);
  for (const [i, e] of ranked.entries()) {
    const s = Math.max(e.gate?.vault_top_score || 0, e.gate?.episodic_top_score || 0);
    console.log(`\n--- #${i + 1} score=${s.toFixed(3)} ---`);
    console.log(`Prompt: ${(e.prompt || '').slice(0, 200)}`);
    if (e.would_inject) console.log(`Would inject:\n${e.would_inject}`);
  }
} else if (healthy.length >= 300 && passRate < 0.02) {
  console.log(`  GATE LIKELY TOO STRICT: ${(passRate * 100).toFixed(1)}% pass rate on ${healthy.length} healthy entries.`);
  console.log(`  Consider lowering LEARNING_LOOP_INJECTION_THRESHOLD below ${threshold} and re-review.`);
} else {
  console.log(`  INCONCLUSIVE: ${passedHealthy.length} passed on ${healthy.length} healthy entries (${(passRate * 100).toFixed(1)}%).`);
  console.log(`  Keep collecting — ${Math.max(0, 20 - passedHealthy.length)} more passes needed for a quality review.`);
}
