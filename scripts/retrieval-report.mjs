#!/usr/bin/env node

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { getPluginData } from './lib/config.mjs';

const PD = getPluginData();
const dir = join(PD, 'retrieval');

function loadJsonl(prefix) {
  const results = [];
  try {
    for (const f of readdirSync(dir)) {
      if (!f.startsWith(prefix) || !f.endsWith('.jsonl')) continue;
      const lines = readFileSync(join(dir, f), 'utf-8').trim().split('\n');
      for (const line of lines) {
        if (!line) continue;
        results.push(JSON.parse(line));
      }
    }
  } catch {}
  return results;
}

const vaultQueries = loadJsonl('queries-');
const memoryReads = loadJsonl('reads-');
const episodicQueries = loadJsonl('episodic-queries-');

if (vaultQueries.length === 0 && memoryReads.length === 0 && episodicQueries.length === 0) {
  console.log('No retrieval data yet.');
  process.exit(0);
}

// --- Vault search queries ---
if (vaultQueries.length > 0) {
  vaultQueries.sort((a, b) => a.ts.localeCompare(b.ts));
  const sessions = new Set(vaultQueries.map(e => e.session_id).filter(Boolean));
  const commands = {};
  const queryFreq = {};
  const pathFreq = {};
  let totalPeerResults = 0;
  let queriesWithPeers = 0;

  for (const e of vaultQueries) {
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

  console.log(`Vault Search`);
  console.log(`${'='.repeat(60)}`);
  console.log(`  Period:          ${vaultQueries[0].ts.slice(0, 10)} to ${vaultQueries.at(-1).ts.slice(0, 10)}`);
  console.log(`  Total queries:   ${vaultQueries.length}`);
  console.log(`  Sessions:        ${sessions.size}`);
  console.log(`  Federated:       ${vaultQueries.filter(e => e.federated).length}/${vaultQueries.length}`);
  console.log(`  With peer hits:  ${queriesWithPeers}/${vaultQueries.length} (${totalPeerResults} peer results total)`);
  console.log();

  console.log(`  Commands:`);
  for (const [cmd, count] of Object.entries(commands).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${cmd.padEnd(15)} ${count}`);
  }
  console.log();

  console.log(`  Most repeated queries:`);
  for (const [q, count] of topQueries) {
    if (count < 2) break;
    console.log(`    ${count}x  ${q.slice(0, 60)}`);
  }
  if (topQueries.every(([, c]) => c < 2)) console.log('    (no repeated queries yet)');
  console.log();

  console.log(`  Most surfaced notes:`);
  for (const [p, count] of topPaths) {
    const short = p.length > 65 ? '...' + p.slice(-62) : p;
    console.log(`    ${String(count).padStart(3)}x  ${short}`);
  }
  console.log();
}

// --- Memory reads ---
if (memoryReads.length > 0) {
  memoryReads.sort((a, b) => a.ts.localeCompare(b.ts));
  const sessions = new Set(memoryReads.map(e => e.session_id).filter(Boolean));
  const fileFreq = {};
  for (const e of memoryReads) {
    fileFreq[e.file] = (fileFreq[e.file] || 0) + 1;
  }
  const topFiles = Object.entries(fileFreq).sort((a, b) => b[1] - a[1]).slice(0, 15);

  console.log(`Memory Reads`);
  console.log(`${'='.repeat(60)}`);
  console.log(`  Period:          ${memoryReads[0].ts.slice(0, 10)} to ${memoryReads.at(-1).ts.slice(0, 10)}`);
  console.log(`  Total reads:     ${memoryReads.length}`);
  console.log(`  Unique files:    ${Object.keys(fileFreq).length}`);
  console.log(`  Sessions:        ${sessions.size}`);
  console.log();

  console.log(`  Most accessed memories:`);
  for (const [f, count] of topFiles) {
    const short = f.length > 55 ? '...' + f.slice(-52) : f;
    console.log(`    ${String(count).padStart(3)}x  ${short}`);
  }
  console.log();
}

// --- Episodic memory queries ---
if (episodicQueries.length > 0) {
  episodicQueries.sort((a, b) => a.ts.localeCompare(b.ts));
  const sessions = new Set(episodicQueries.map(e => e.session_id).filter(Boolean));
  const queryFreq = {};
  for (const e of episodicQueries) {
    const q = e.query?.toLowerCase().trim();
    if (q) queryFreq[q] = (queryFreq[q] || 0) + 1;
  }
  const topQueries = Object.entries(queryFreq).sort((a, b) => b[1] - a[1]).slice(0, 10);

  console.log(`Episodic Memory`);
  console.log(`${'='.repeat(60)}`);
  console.log(`  Period:          ${episodicQueries[0].ts.slice(0, 10)} to ${episodicQueries.at(-1).ts.slice(0, 10)}`);
  console.log(`  Total queries:   ${episodicQueries.length}`);
  console.log(`  Sessions:        ${sessions.size}`);
  console.log();

  console.log(`  Most repeated queries:`);
  for (const [q, count] of topQueries) {
    if (count < 2) break;
    console.log(`    ${count}x  ${q.slice(0, 60)}`);
  }
  if (topQueries.every(([, c]) => c < 2)) console.log('    (no repeated queries yet)');
  console.log();
}

// --- Summary ---
console.log(`Summary`);
console.log(`${'='.repeat(60)}`);
console.log(`  Vault queries:     ${vaultQueries.length}`);
console.log(`  Memory reads:      ${memoryReads.length}`);
console.log(`  Episodic queries:  ${episodicQueries.length}`);
console.log(`  Total events:      ${vaultQueries.length + memoryReads.length + episodicQueries.length}`);
