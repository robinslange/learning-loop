#!/usr/bin/env node
// retrieval-report.mjs — surfacing + usage report over retrieval telemetry.
//
// Modes:
//   (default)                    full surfacing report + note-usage section
//   --usage [--json]             note-usage section only (consumed by /health)
//   --session-surfaced <sid>     JSON list of notes surfaced to one session
//                                (consumed by /reflect Step 4.7)

import { readFileSync, readdirSync } from 'fs';
import { join, sep } from 'path';
import { getPluginData, getVaultPath } from './lib/config.mjs';
import { logError } from './lib/log.mjs';
import { sessionSurfaced, usageReport } from './lib/retrieval-usage.mjs';
import { listVaultNotes } from './lib/vault-walk.mjs';

const PD = getPluginData();
const dir = join(PD, 'retrieval');

const args = process.argv.slice(2);

if (args[0] === '--session-surfaced') {
  const sid = args[1];
  if (!sid) {
    console.error('Usage: retrieval-report.mjs --session-surfaced <session-id>');
    process.exit(1);
  }
  console.log(JSON.stringify(sessionSurfaced(PD, sid), null, 2));
  process.exit(0);
}

const USAGE_FOLDERS = ['0-inbox', '1-fleeting', '2-literature', '3-permanent'];

function vaultContentNotes() {
  const vault = getVaultPath();
  if (!vault) return null;
  return listVaultNotes(vault)
    .map((n) =>
      n.path
        .slice(vault.length + 1)
        .split(sep)
        .join('/'),
    )
    .filter((p) => USAGE_FOLDERS.some((f) => p.startsWith(f + '/')));
}

function printUsageSection() {
  const report = usageReport(PD, { vaultNotes: vaultContentNotes() });

  console.log(`Note Usage`);
  console.log(`${'='.repeat(60)}`);
  if (report.coverage_days === null) {
    console.log('  No surfacing telemetry yet.');
    console.log();
    return;
  }
  const coverage = report.coverage_limited
    ? `last ${report.window_days}d window, but logs only cover ${report.coverage_days}d`
    : `last ${report.window_days}d`;
  console.log(`  Window:          ${coverage}`);
  const breakdown = [
    `${report.used_engaged_events} engaged`,
    `${report.used_informed_events} informed`,
  ];
  if (report.used_unspecified_events > 0) {
    breakdown.push(`${report.used_unspecified_events} unspecified`);
  }
  console.log(
    `  Usage events:    ${report.used_events} used (${breakdown.join(' / ')}) / ${report.ignored_events} ignored across ${report.evaluated_notes} notes (from /reflect)`,
  );
  if (report.unevidenced_informed_events > 0) {
    console.log(
      `                   ${report.unevidenced_informed_events} 'informed' events dropped for carrying no evidence (counted neither way)`,
    );
  }
  console.log(`  Surfaced notes:  ${report.surfaced_notes} in window`);
  console.log();

  console.log(`  Frequently surfaced, then explicitly ignored (deepen/archive candidates):`);
  console.log(
    `  (a candidate needs >=${report.min_ignored} explicit 'ignored' event from /reflect; a note no`,
  );
  console.log(`   session ever judged is unevaluated, which is not evidence of non-use)`);
  if (report.surfaced_never_used.length === 0) {
    console.log('    (none)');
  }
  for (const n of report.surfaced_never_used.slice(0, 15)) {
    const short = n.path.length > 60 ? '...' + n.path.slice(-57) : n.path;
    console.log(
      `    ${String(n.surfaced).padStart(3)}x  ${short}  (${n.ignored_events} explicit ignores)`,
    );
  }
  console.log();

  if (report.surfaced_unevaluated.length > 0) {
    const top = report.surfaced_unevaluated[0];
    console.log(
      `  Surfaced repeatedly but never evaluated: ${report.surfaced_unevaluated.length} notes (up to ${top.surfaced}x)`,
    );
    console.log(
      `  (no /reflect ran the usage check on them — telemetry gap, not archive candidates)`,
    );
    console.log();
  }

  if (report.never_surfaced.length > 0) {
    const span = report.coverage_limited
      ? `${report.coverage_days}d of logs`
      : `${report.window_days}d`;
    console.log(
      `  Never retrieved by search in ${span} (archive candidates): ${report.never_surfaced.length} notes`,
    );
    console.log(
      `  (injection-only notes may also appear here — the injected channel under-records)`,
    );
    console.log(
      `  (use this to find notes retrieval never surfaces; not a reliable indicator they were never seen)`,
    );
    for (const p of report.never_surfaced.slice(0, 20)) {
      console.log(`    ${p}`);
    }
    if (report.never_surfaced.length > 20) {
      console.log(`    ... +${report.never_surfaced.length - 20} more`);
    }
    console.log();
  }
}

if (args.includes('--usage')) {
  if (args.includes('--json')) {
    console.log(JSON.stringify(usageReport(PD, { vaultNotes: vaultContentNotes() }), null, 2));
  } else {
    printUsageSection();
  }
  process.exit(0);
}

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
  } catch (err) {
    logError('retrieval-report.loadJsonl', err);
  }
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
  const sessions = new Set(vaultQueries.map((e) => e.session_id).filter(Boolean));
  const commands = {};
  const queryFreq = {};
  const pathFreq = {};
  let totalPeerResults = 0;
  let queriesWithPeers = 0;

  for (const e of vaultQueries) {
    commands[e.command] = (commands[e.command] || 0) + 1;
    const q = typeof e.query === 'string' ? e.query.toLowerCase().trim() : '';
    if (q) queryFreq[q] = (queryFreq[q] || 0) + 1;
    for (const p of e.top_paths || []) {
      pathFreq[p] = (pathFreq[p] || 0) + 1;
    }
    if (e.peer_results > 0) {
      totalPeerResults += e.peer_results;
      queriesWithPeers++;
    }
  }

  const topQueries = Object.entries(queryFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  const topPaths = Object.entries(pathFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  console.log(`Vault Search`);
  console.log(`${'='.repeat(60)}`);
  console.log(
    `  Period:          ${vaultQueries[0].ts.slice(0, 10)} to ${vaultQueries.at(-1).ts.slice(0, 10)}`,
  );
  console.log(`  Total queries:   ${vaultQueries.length}`);
  console.log(`  Sessions:        ${sessions.size}`);
  console.log(
    `  Federated:       ${vaultQueries.filter((e) => e.federated).length}/${vaultQueries.length}`,
  );
  console.log(
    `  With peer hits:  ${queriesWithPeers}/${vaultQueries.length} (${totalPeerResults} peer results total)`,
  );
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
  const sessions = new Set(memoryReads.map((e) => e.session_id).filter(Boolean));
  const fileFreq = {};
  for (const e of memoryReads) {
    fileFreq[e.file] = (fileFreq[e.file] || 0) + 1;
  }
  const topFiles = Object.entries(fileFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);

  console.log(`Memory Reads`);
  console.log(`${'='.repeat(60)}`);
  console.log(
    `  Period:          ${memoryReads[0].ts.slice(0, 10)} to ${memoryReads.at(-1).ts.slice(0, 10)}`,
  );
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
  const sessions = new Set(episodicQueries.map((e) => e.session_id).filter(Boolean));
  const queryFreq = {};
  for (const e of episodicQueries) {
    const q = typeof e.query === 'string' ? e.query.toLowerCase().trim() : '';
    if (q) queryFreq[q] = (queryFreq[q] || 0) + 1;
  }
  const topQueries = Object.entries(queryFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  console.log(`Episodic Memory`);
  console.log(`${'='.repeat(60)}`);
  console.log(
    `  Period:          ${episodicQueries[0].ts.slice(0, 10)} to ${episodicQueries.at(-1).ts.slice(0, 10)}`,
  );
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
console.log(
  `  Total events:      ${vaultQueries.length + memoryReads.length + episodicQueries.length}`,
);
console.log();

printUsageSection();
