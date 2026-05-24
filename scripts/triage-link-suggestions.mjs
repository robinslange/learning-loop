#!/usr/bin/env node
// triage-link-suggestions.mjs — Rank pending link_suggestion queue items.
//
// Usage:
//   node scripts/triage-link-suggestions.mjs [--threshold N] [--limit N]
//                                            [--order asc|desc]
//                                            [--sort model_prob|cosine|created_at]
//
// Reads PLUGIN_DATA/librarian/queue.jsonl, filters pending link suggestions,
// sorts by the chosen signal, and prints a tight table.
//
// Default sort is `model_prob` desc — the only gemma-side signal that
// correlated with the substitution-test rubric in the 2026-05-11 calibration
// (AUROC 0.708). Items lacking model_prob fall back to cosine ASC (AUROC 0.117
// inverted — low cosine = cross-cluster bridge). Items lacking BOTH sink to
// the bottom regardless of order.
//
// Sort options:
//   model_prob   normalized P(confidence) at generation time (F1, default)
//   cosine       embedding cosine score (Spike B). Default --order asc.
//   created_at   ISO timestamp.
//
// --order applies to the chosen --sort. Default order: model_prob=desc,
// cosine=asc, created_at=desc.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { env } from './lib/env.mjs';
import { logError } from './lib/log.mjs';
import { DATA_PATHS } from './lib/paths.mjs';

const pluginData =
  env.CLAUDE_PLUGIN_DATA ||
  join(homedir(), '.claude', 'plugins', 'data', 'learning-loop-learning-loop-marketplace');
const queuePath = DATA_PATHS.librarianQueue(pluginData);

if (!existsSync(queuePath)) {
  console.error(`No queue at ${queuePath}`);
  process.exit(1);
}

const args = process.argv.slice(2);
function flagNum(name) {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const v = Number(args[i + 1]);
  return Number.isFinite(v) ? v : null;
}
const threshold = flagNum('--threshold');
const limit = flagNum('--limit');

function flagStr(name, fallback) {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  return args[i + 1] ?? fallback;
}
const sort = flagStr('--sort', 'model_prob');
if (sort !== 'model_prob' && sort !== 'cosine' && sort !== 'created_at') {
  console.error(`--sort must be model_prob, cosine, or created_at (got ${sort})`);
  process.exit(2);
}
const defaultOrder = sort === 'cosine' ? 'asc' : 'desc';
const order = flagStr('--order', defaultOrder);
if (order !== 'asc' && order !== 'desc') {
  console.error(`--order must be asc or desc (got ${order})`);
  process.exit(2);
}

const items = [];
for (const line of readFileSync(queuePath, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  try {
    const item = JSON.parse(line);
    if (item.task !== 'link_suggestion') continue;
    if (item.status !== 'pending' && item.status !== 'acknowledged') continue;
    items.push(item);
  } catch (err) {
    logError('triage-link-suggestions.parseLine', err);
  }
}

const filtered =
  threshold !== null
    ? items.filter((it) => typeof it.cosine_score === 'number' && it.cosine_score >= threshold)
    : items;

function hasKey(it, key) {
  if (key === 'created_at') return typeof it.created_at === 'string' && it.created_at.length > 0;
  return typeof it[key] === 'number';
}

function cmpValues(a, b, key, dir) {
  if (key === 'created_at') {
    const av = a.created_at || '';
    const bv = b.created_at || '';
    return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
  }
  return dir === 'asc' ? a[key] - b[key] : b[key] - a[key];
}

filtered.sort((a, b) => {
  const aPri = hasKey(a, sort);
  const bPri = hasKey(b, sort);
  if (aPri && !bPri) return -1;
  if (!aPri && bPri) return 1;
  if (aPri && bPri) {
    const primary = cmpValues(a, b, sort, order);
    if (primary !== 0) return primary;
  }
  // Tie-break / fallback: cosine asc, then created_at desc. Items lacking BOTH
  // model_prob and cosine sink to bottom relative to items with cosine.
  const aCos = typeof a.cosine_score === 'number';
  const bCos = typeof b.cosine_score === 'number';
  if (aCos && !bCos) return -1;
  if (!aCos && bCos) return 1;
  if (aCos && bCos) {
    const c = a.cosine_score - b.cosine_score;
    if (c !== 0) return c;
  }
  const aCa = a.created_at || '';
  const bCa = b.created_at || '';
  return bCa.localeCompare(aCa);
});

const rows = limit !== null ? filtered.slice(0, limit) : filtered;

if (rows.length === 0) {
  console.log('No matching link suggestions.');
  process.exit(0);
}

const withCos = rows.filter((r) => typeof r.cosine_score === 'number').length;
const withMp = rows.filter((r) => typeof r.model_prob === 'number').length;
console.log(
  `${rows.length} link suggestions (${withMp} with model_prob, ${withCos} with cosine; sort=${sort} ${order})`,
);
console.log('');

function trunc(s, n) {
  if (typeof s !== 'string') return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  const mp = typeof r.model_prob === 'number' ? r.model_prob.toFixed(3) : '  ?  ';
  const cos = typeof r.cosine_score === 'number' ? r.cosine_score.toFixed(3) : '  ?  ';
  const rank = String(i + 1).padStart(4);
  const arrow = `${r.target} → ${r.suggested_link}`;
  const reason = trunc(r.reason || '', 60);
  console.log(`${rank}  mp=${mp}  cos=${cos}  ${arrow}`);
  if (reason) console.log(`        ${reason}`);
}
