#!/usr/bin/env node
// provenance-report.mjs — Reads events + scores, computes 5 core metrics, outputs markdown report

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getPluginData } from './lib/config.mjs';

const PROVENANCE_DIR = join(getPluginData(), 'provenance');
const SUMMARIES_DIR = join(PROVENANCE_DIR, 'summaries');

function readAllEvents() {
  if (!existsSync(PROVENANCE_DIR)) return [];
  const files = readdirSync(PROVENANCE_DIR)
    .filter(f => f.startsWith('events-') && f.endsWith('.jsonl'))
    .sort();
  const events = [];
  for (const file of files) {
    const lines = readFileSync(join(PROVENANCE_DIR, file), 'utf8')
      .trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try { events.push(JSON.parse(line)); } catch {}
    }
  }
  return events;
}

function loadSummaries() {
  if (!existsSync(SUMMARIES_DIR)) return [];
  return readdirSync(SUMMARIES_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => {
      try { return JSON.parse(readFileSync(join(SUMMARIES_DIR, f), 'utf8')); }
      catch { return null; }
    })
    .filter(Boolean);
}

const events = readAllEvents();
if (events.length === 0) {
  console.log('No provenance events recorded yet.');
  process.exit(0);
}

// Separate event types
const sessionStarts = events.filter(e => e.action === 'session-start' && e.skill);
const vaultWrites = events.filter(e => e.action === 'vault-write');
const scores = events.filter(e => e.action === 'score');

// Unique sessions (skill-level, not hook-level)
const sessions = new Set(sessionStarts.map(e => e.session_id));

// Notes created (from hook vault-writes to fleeting/inbox/permanent)
const noteCreations = vaultWrites.filter(e =>
  ['fleeting', 'inbox', 'permanent'].includes(e.folder)
);
const uniqueNotes = new Set(noteCreations.map(e => e.target));

// Verified notes (notes that have at least one score record)
const scoredNotes = new Set(scores.map(e => e.target));
const flaggedNotes = new Set(scores.filter(e => e.result === 'fail').map(e => e.target));
const unverifiedNotes = [...uniqueNotes].filter(n => !scoredNotes.has(n));

// --- Metric 1: Finding rate by type ---
const findingsByType = {};
for (const s of scores) {
  if (s.result !== 'fail') continue;
  const t = s.finding_type || 'unknown';
  if (!findingsByType[t]) findingsByType[t] = { count: 0, ambiguous: 0 };
  findingsByType[t].count++;
  if (s.confidence === 'ambiguous') findingsByType[t].ambiguous++;
}
const totalFindings = Object.values(findingsByType).reduce((a, b) => a + b.count, 0);

// --- Metric 2: Finding rate by config ---
// Join session-start config to vault-writes by session_id, then to scores by note filename
const sessionConfigs = {};
for (const e of sessionStarts) {
  sessionConfigs[e.session_id] = { skill: e.skill, config: e.config || {} };
}
const noteToSession = {};
for (const e of noteCreations) {
  noteToSession[e.target] = e.session_id;
}
const configStats = {};
for (const note of uniqueNotes) {
  const sid = noteToSession[note];
  const cfg = sessionConfigs[sid];
  if (!cfg) continue;
  const key = `${cfg.skill} depth=${cfg.config.depth || 'default'}`;
  if (!configStats[key]) configStats[key] = { total: 0, flagged: 0 };
  configStats[key].total++;
  if (flaggedNotes.has(note)) configStats[key].flagged++;
}

// --- Metric 3: Auto vs manual catch rate ---
const findingsByTrigger = {};
for (const s of scores) {
  if (s.result !== 'fail') continue;
  const t = s.trigger || 'unknown';
  findingsByTrigger[t] = (findingsByTrigger[t] || 0) + 1;
}

// --- Build report ---
let out = '';
out += `## Provenance Report\n\n`;

// Volume
out += `### Volume\n`;
out += `Sessions: ${sessions.size} | Notes created: ${uniqueNotes.size} | Verified: ${scoredNotes.size} | Unverified: ${unverifiedNotes.length}\n\n`;

// Metric 1: Finding rate by type
if (totalFindings > 0) {
  out += `### Findings by type\n`;
  const sorted = Object.entries(findingsByType).sort((a, b) => b[1].count - a[1].count);
  for (const [type, data] of sorted) {
    const pct = (data.count / totalFindings * 100).toFixed(0);
    const ambig = data.ambiguous > 0 ? ` (${data.ambiguous} ambiguous)` : '';
    out += `- **${type}**: ${data.count} (${pct}%)${ambig}\n`;
  }
  out += '\n';
}

// Metric 2: Finding rate by config
if (Object.keys(configStats).length > 0) {
  out += `### Config correlation\n`;
  const sorted = Object.entries(configStats).sort((a, b) => {
    const rateA = a[1].total > 0 ? a[1].flagged / a[1].total : 0;
    const rateB = b[1].total > 0 ? b[1].flagged / b[1].total : 0;
    return rateA - rateB;
  });
  for (const [key, data] of sorted) {
    const rate = data.total > 0 ? (data.flagged / data.total * 100).toFixed(0) : 'n/a';
    out += `- ${key}: ${data.flagged}/${data.total} flagged (${rate}%)\n`;
  }
  out += '\n';
}

// Metric 3: Auto vs manual
if (Object.keys(findingsByTrigger).length > 0) {
  out += `### Trigger analysis\n`;
  for (const [trigger, count] of Object.entries(findingsByTrigger).sort((a, b) => b[1] - a[1])) {
    out += `- ${trigger}: ${count}\n`;
  }
  out += '\n';
}

// Metric 4: Unverified backlog
if (unverifiedNotes.length > 0) {
  out += `### Unverified backlog\n`;
  out += `${unverifiedNotes.length} notes have no verification scores.\n\n`;
}

// Metric 5: Taxonomy health
const ambiguousTypes = Object.entries(findingsByType)
  .filter(([, d]) => d.count >= 3 && d.ambiguous / d.count > 0.3);
const lowTypes = Object.entries(findingsByType)
  .filter(([, d]) => d.count <= 1 && totalFindings > 20);
if (ambiguousTypes.length > 0 || lowTypes.length > 0) {
  out += `### Taxonomy health\n`;
  for (const [type, data] of ambiguousTypes) {
    const rate = (data.ambiguous / data.count * 100).toFixed(0);
    out += `- **${type}**: ${rate}% ambiguous -- consider splitting or clarifying boundary\n`;
  }
  for (const [type] of lowTypes) {
    out += `- **${type}**: <2% of findings -- merge candidate\n`;
  }
  out += '\n';
}

// Recommendations
const recs = [];

// Config recommendation: if any config has >2x the failure rate of another
const configEntries = Object.entries(configStats).filter(([, d]) => d.total >= 5);
if (configEntries.length >= 2) {
  const rates = configEntries.map(([k, d]) => ({ key: k, rate: d.flagged / d.total }));
  rates.sort((a, b) => a.rate - b.rate);
  const best = rates[0];
  const worst = rates[rates.length - 1];
  if (worst.rate > 0 && best.rate >= 0 && worst.rate / Math.max(best.rate, 0.01) >= 2) {
    const ratio = (worst.rate / Math.max(best.rate, 0.01)).toFixed(1);
    recs.push(`${worst.key} produces ${ratio}x the failure rate of ${best.key}. Consider changing default.`);
  }
}

// Top finding type recommendation
if (totalFindings >= 5) {
  const top = Object.entries(findingsByType).sort((a, b) => b[1].count - a[1].count)[0];
  if (top) {
    recs.push(`${top[0]} is the most common finding (${top[1].count}). Review skill prompts for targeted mitigation.`);
  }
}

// Backlog recommendation
if (unverifiedNotes.length > scoredNotes.size) {
  recs.push(`Unverified notes (${unverifiedNotes.length}) exceed verified (${scoredNotes.size}). Run /verify on recent sessions.`);
}

if (recs.length > 0) {
  out += `### Recommendations\n`;
  recs.forEach((r, i) => { out += `${i + 1}. ${r}\n`; });
  out += '\n';
}

// No findings at all
if (totalFindings === 0 && uniqueNotes.size > 0) {
  out += `### No findings yet\n`;
  out += `${uniqueNotes.size} notes created but no verification scores recorded. Run /verify to start the feedback loop.\n\n`;
}

console.log(out);
