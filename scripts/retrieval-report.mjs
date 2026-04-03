#!/usr/bin/env node

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const PD = process.env.CLAUDE_PLUGIN_DATA
  || join(process.env.HOME || process.env.USERPROFILE, '.claude', 'plugins', 'data', 'learning-loop');
const dir = join(PD, 'retrieval');

let entries = [];
try {
  for (const f of readdirSync(dir)) {
    if (!f.startsWith('queries-') || !f.endsWith('.jsonl')) continue;
    const lines = readFileSync(join(dir, f), 'utf-8').trim().split('\n');
    for (const line of lines) {
      if (!line) continue;
      entries.push(JSON.parse(line));
    }
  }
} catch {
  console.log('No retrieval data yet.');
  process.exit(0);
}

if (entries.length === 0) {
  console.log('No retrieval data yet.');
  process.exit(0);
}

entries.sort((a, b) => a.ts.localeCompare(b.ts));

const sessions = new Set(entries.map(e => e.session_id).filter(Boolean));
const commands = {};
const queryFreq = {};
const pathFreq = {};
let totalPeerResults = 0;
let queriesWithPeers = 0;

for (const e of entries) {
  commands[e.command] = (commands[e.command] || 0) + 1;

  const q = e.query?.toLowerCase().trim();
  if (q) queryFreq[q] = (queryFreq[q] || 0) + 1;

  for (const p of (e.top_paths || [])) {
    pathFreq[p] = (pathFreq[p] || 0) + 1;
  }

  if (e.peer_results > 0) {
    totalPeerResults += e.peer_results;
    queriesWithPeers++;
  }
}

const topQueries = Object.entries(queryFreq).sort((a, b) => b[1] - a[1]).slice(0, 10);
const topPaths = Object.entries(pathFreq).sort((a, b) => b[1] - a[1]).slice(0, 10);

console.log(`Retrieval Report`);
console.log(`${'='.repeat(60)}`);
console.log(`  Period:          ${entries[0].ts.slice(0, 10)} to ${entries[entries.length - 1].ts.slice(0, 10)}`);
console.log(`  Total queries:   ${entries.length}`);
console.log(`  Sessions:        ${sessions.size}`);
console.log(`  Federated:       ${entries.filter(e => e.federated).length}/${entries.length}`);
console.log(`  With peer hits:  ${queriesWithPeers}/${entries.length} (${totalPeerResults} peer results total)`);
console.log();

console.log(`Commands:`);
for (const [cmd, count] of Object.entries(commands).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${cmd.padEnd(15)} ${count}`);
}
console.log();

console.log(`Most repeated queries:`);
for (const [q, count] of topQueries) {
  if (count < 2) break;
  console.log(`  ${count}x  ${q.slice(0, 60)}`);
}
if (topQueries.every(([, c]) => c < 2)) console.log('  (no repeated queries yet)');
console.log();

console.log(`Most surfaced notes:`);
for (const [p, count] of topPaths) {
  const short = p.length > 65 ? '...' + p.slice(-62) : p;
  console.log(`  ${String(count).padStart(3)}x  ${short}`);
}
