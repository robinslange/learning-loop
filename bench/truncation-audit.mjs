#!/usr/bin/env node
// truncation-audit.mjs — how much of each note does the encoder actually see?
//
// preprocess.rs caps the embedding input at MAX_TEXT_LENGTH bytes before the
// tokenizer runs, so bge-small's 512-token window is not the binding limit.
// This measures the gap on a real vault, per folder, because the average hides
// the shape: the folders that are most source-dense and most link-dense are the
// ones most heavily cut.
//
// Byte counts are exact. Token counts are estimated from a bytes-per-token
// ratio, since the tokenizer lives in the Rust binary; --ratio overrides it.
//
// Usage: node bench/truncation-audit.mjs [--vault path] [--cap 1500] [--ratio 4.0]

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const VAULT = arg('--vault', join(process.env.HOME, 'brain/brain'));
const CAP = Number(arg('--cap', '1500'));
const RATIO = Number(arg('--ratio', '4.0')); // bytes per token, English technical prose
const MAX_TOKENS = Number(arg('--max-tokens', '512'));
const asJson = argv.includes('--json');

// Mirrors preprocess.rs: frontmatter is stripped before the cap applies, and
// wikilink syntax is cleaned. Measuring the raw file would overstate the loss.
function stripFrontmatter(raw) {
  if (!raw.startsWith('---')) return raw;
  const end = raw.indexOf('\n---', 3);
  return end === -1 ? raw : raw.slice(raw.indexOf('\n', end + 1) + 1);
}
const cleanWikilinks = (s) => s.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, '$1');

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

const byFolder = new Map();
let all = [];
for (const file of walk(VAULT)) {
  const rel = relative(VAULT, file);
  const folder = rel.split('/')[0];
  if (folder.startsWith('_')) continue;
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const body = cleanWikilinks(stripFrontmatter(raw)).trim();
  if (!body) continue;
  const bytes = Buffer.byteLength(body, 'utf8');
  const rec = { folder, bytes };
  all.push(rec);
  if (!byFolder.has(folder)) byFolder.set(folder, []);
  byFolder.get(folder).push(rec);
}

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};
const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + '%' : 'n/a');

// Bytes the encoder would see under each limit. The token limit is what SHOULD
// bind; the byte cap is what does.
const tokenCapBytes = MAX_TOKENS * RATIO;

function summarize(recs) {
  const n = recs.length;
  const over = recs.filter((r) => r.bytes > CAP).length;
  const overToken = recs.filter((r) => r.bytes > tokenCapBytes).length;
  const seenNow = recs.reduce((a, r) => a + Math.min(r.bytes, CAP), 0);
  const seenFixed = recs.reduce((a, r) => a + Math.min(r.bytes, tokenCapBytes), 0);
  const total = recs.reduce((a, r) => a + r.bytes, 0);
  return {
    n,
    over_cap: over,
    over_cap_pct: over / n,
    over_token_limit: overToken,
    median_bytes: median(recs.map((r) => r.bytes)),
    coverage_now: seenNow / total,
    coverage_fixed: seenFixed / total,
  };
}

const report = {
  vault: VAULT,
  cap: CAP,
  max_tokens: MAX_TOKENS,
  bytes_per_token: RATIO,
  token_cap_bytes: tokenCapBytes,
  overall: summarize(all),
  folders: Object.fromEntries(
    [...byFolder.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([f, recs]) => [f, summarize(recs)]),
  ),
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const o = report.overall;
  console.log(`Embedding truncation audit — ${VAULT}`);
  console.log('='.repeat(72));
  console.log(`  byte cap ${CAP}; token limit ${MAX_TOKENS} ~= ${tokenCapBytes} bytes at ${RATIO} B/tok\n`);
  console.log(`  notes:              ${o.n}`);
  console.log(`  over the byte cap:  ${o.over_cap}  (${pct(o.over_cap, o.n)})`);
  console.log(`  over the TOKEN cap: ${o.over_token_limit}  (${pct(o.over_token_limit, o.n)})  <- irreducible`);
  console.log(`  body text encoded:  ${pct(o.coverage_now * 100, 100)} now  ->  ${pct(o.coverage_fixed * 100, 100)} if the tokenizer bound\n`);
  console.log('  folder            notes   >cap   median B   encoded now -> fixed');
  for (const [f, s] of Object.entries(report.folders)) {
    console.log(
      `  ${f.padEnd(16)} ${String(s.n).padStart(5)}  ${pct(s.over_cap, s.n).padStart(6)}  ` +
        `${String(s.median_bytes).padStart(8)}   ${pct(s.coverage_now * 100, 100).padStart(6)} -> ${pct(s.coverage_fixed * 100, 100)}`,
    );
  }
}
