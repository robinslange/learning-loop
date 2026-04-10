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
const passed = entries.filter(e => e.gate?.passed === true);

function percentiles(values) {
  if (values.length === 0) return { p50: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const p = (pct) => sorted[Math.floor((pct / 100) * (sorted.length - 1))];
  return { p50: p(50), p95: p(95), max: sorted[sorted.length - 1] };
}

const vaultLat = entries.map(e => e.backends?.vault?.latency_ms).filter(Boolean);
const episodicLat = entries.map(e => e.backends?.episodic?.latency_ms).filter(Boolean);
const racedOut = entries.filter(e => e.backends?.episodic?.raced_out).length;

console.log('# Shadow injection review\n');
console.log(`Total entries: ${total}`);
console.log(`Fast-path skips: ${fastPathSkips} (${((fastPathSkips / total) * 100).toFixed(1)}%)`);
console.log(`Gate pass rate: ${passed.length} / ${total} = ${((passed.length / total) * 100).toFixed(1)}%`);
console.log(`\nVault latency: p50=${percentiles(vaultLat).p50}ms p95=${percentiles(vaultLat).p95}ms max=${percentiles(vaultLat).max}ms`);
console.log(`Episodic latency: p50=${percentiles(episodicLat).p50}ms p95=${percentiles(episodicLat).p95}ms max=${percentiles(episodicLat).max}ms`);
console.log(`Episodic raced out: ${racedOut} / ${entries.length - fastPathSkips}`);
console.log(`\n${passed.length} passed-gate entries`);

if (passed.length < 50) {
  console.log(`\n=> NOT READY. ${50 - passed.length} more entries needed before go/no-go decision.`);
  if (total >= 200) {
    console.log(`\n[WARN] ${total} total prompts but only ${passed.length} passed. Lower gate threshold (0.65 -> 0.55) and re-review.`);
  }
  if (total >= 400) {
    console.log(`\n[STOP] ${total} prompts, ${passed.length} passed. Feature has failed Phase 1 validation. Delete the branch.`);
  }
} else {
  console.log(`\n=> READY FOR REVIEW. Top 50 highest-confidence injections:`);
  const ranked = [...passed].sort((a, b) => (b.gate.vault_top_score || 0) - (a.gate.vault_top_score || 0)).slice(0, 50);
  for (const [i, e] of ranked.entries()) {
    console.log(`\n--- #${i + 1} score=${(e.gate.vault_top_score || 0).toFixed(3)} ---`);
    console.log(`Prompt: ${e.prompt}`);
    console.log(`Would inject:\n${e.would_inject}`);
  }
}
