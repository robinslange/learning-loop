#!/usr/bin/env node
// cache-health-report.mjs — Summarize cache-health JSONL data
//
// Usage:
//   node scripts/cache-health-report.mjs [--session <id>] [--month YYYY-MM]
//
// Reports: hit rate percentiles, total cost, session breakdown, 0%-hit events.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const pluginData =
  process.env.CLAUDE_PLUGIN_DATA ||
  join(homedir(), '.claude', 'plugins', 'data', 'learning-loop-learning-loop-marketplace');
const dir = join(pluginData, 'retrieval');

if (!existsSync(dir)) {
  console.error(`No retrieval directory at ${dir}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const sessionFilter = args.includes('--session') ? args[args.indexOf('--session') + 1] : null;
const monthFilter = args.includes('--month') ? args[args.indexOf('--month') + 1] : null;

const files = readdirSync(dir)
  .filter(f => f.startsWith('cache-health-') && f.endsWith('.jsonl'))
  .filter(f => !monthFilter || f.includes(monthFilter));

if (files.length === 0) {
  console.log('No cache-health logs found.');
  process.exit(0);
}

const rows = [];
for (const f of files) {
  for (const line of readFileSync(join(dir, f), 'utf8').trim().split('\n')) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      if (sessionFilter && r.session_id !== sessionFilter) continue;
      rows.push(r);
    } catch {}
  }
}

if (rows.length === 0) {
  console.log('No matching rows.');
  process.exit(0);
}

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor((p / 100) * (sorted.length - 1))];
}

const hitRates = rows.map(r => r.hit_rate);
const totalRead = rows.reduce((s, r) => s + r.cache_read, 0);
const totalCreate = rows.reduce((s, r) => s + r.cache_creation, 0);
const totalUncached = rows.reduce((s, r) => s + r.uncached_input, 0);
const totalInput = totalRead + totalCreate + totalUncached;
const overallHitRate = totalInput > 0 ? totalRead / totalInput : 0;
const zeroHits = rows.filter(r => r.hit_rate === 0).length;

const sessionIds = new Set(rows.map(r => r.session_id));
const sessions = [...sessionIds].map(sid => {
  const sr = rows.filter(r => r.session_id === sid);
  const sRead = sr.reduce((s, r) => s + r.cache_read, 0);
  const sCreate = sr.reduce((s, r) => s + r.cache_creation, 0);
  const sUncached = sr.reduce((s, r) => s + r.uncached_input, 0);
  const sTotal = sRead + sCreate + sUncached;
  return {
    id: sid.slice(0, 8),
    turns: sr.length,
    hit_rate: sTotal > 0 ? sRead / sTotal : 0,
    cost: sr[sr.length - 1]?.total_cost_usd ?? 0,
    total_tokens: sTotal,
  };
});
sessions.sort((a, b) => b.turns - a.turns);

console.log('# Cache Health Report\n');
console.log(`Files: ${files.join(', ')}`);
console.log(`Rows: ${rows.length}`);
console.log(`Sessions: ${sessionIds.size}`);
console.log(`Date range: ${rows[0].ts} → ${rows[rows.length - 1].ts}\n`);

console.log('## Overall');
console.log(`Weighted hit rate: ${(overallHitRate * 100).toFixed(2)}%`);
console.log(`Total cache read:     ${totalRead.toLocaleString()} tokens`);
console.log(`Total cache created:  ${totalCreate.toLocaleString()} tokens`);
console.log(`Total uncached input: ${totalUncached.toLocaleString()} tokens`);
console.log(`Zero-hit turns: ${zeroHits} (${((zeroHits / rows.length) * 100).toFixed(1)}%)\n`);

console.log('## Per-turn hit rate distribution');
console.log(`p50: ${(percentile(hitRates, 50) * 100).toFixed(1)}%`);
console.log(`p25: ${(percentile(hitRates, 25) * 100).toFixed(1)}%`);
console.log(`p10: ${(percentile(hitRates, 10) * 100).toFixed(1)}%`);
console.log(`min: ${(Math.min(...hitRates) * 100).toFixed(1)}%`);
console.log(`max: ${(Math.max(...hitRates) * 100).toFixed(1)}%\n`);

console.log('## Top sessions by turn count');
console.log('session   turns  hit%   cost      tokens');
for (const s of sessions.slice(0, 10)) {
  console.log(
    `${s.id}  ${String(s.turns).padStart(5)}  ${(s.hit_rate * 100).toFixed(1).padStart(5)}%  $${s.cost.toFixed(2).padStart(6)}  ${s.total_tokens.toLocaleString()}`
  );
}

if (zeroHits > 0) {
  console.log('\n## Zero-hit events (cache busts)');
  const busts = rows.filter(r => r.hit_rate === 0).slice(0, 10);
  for (const r of busts) {
    console.log(`${r.ts}  session=${r.session_id.slice(0, 8)}  create=${r.cache_creation.toLocaleString()}`);
  }
}
