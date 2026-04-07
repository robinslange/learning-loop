#!/usr/bin/env node
// calibrate-classifier.mjs — Stratified sample of inferred edges with the
// surrounding text from each source note. Writes a Markdown worksheet for
// you to label, then computes precision per stratum.
//
// Usage:
//   node calibrate-classifier.mjs sample [--n 50] [--out worksheet.md]
//   node calibrate-classifier.mjs score worksheet.md
//
// Worksheet format: each edge is a section with a [ ] correct / [ ] wrong / [ ] wrong-type checkbox row.
// `score` parses the checked boxes and reports precision overall and per stratum.

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { PLUGIN_DATA, VAULT_PATH } from './lib/constants.mjs';
import { openEdgeDb } from './lib/edges.mjs';

const DB_FILE = join(PLUGIN_DATA, 'edges.db');
const args = process.argv.slice(2);
const cmd = args[0];

function flag(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}

function rowsToObjects(result) {
  if (!result || result.length === 0) return [];
  const { columns, values } = result[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function extractContext(fromPath, toTarget) {
  try {
    const fullPath = join(VAULT_PATH, fromPath);
    const content = readFileSync(fullPath, 'utf-8');
    const fmEnd = content.match(/^---\n[\s\S]*?\n---\n?/);
    const body = fmEnd ? content.slice(fmEnd[0].length) : content;
    const linkRe = new RegExp(`\\[\\[${toTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\|[^\\]]+)?\\]\\]`);
    const m = linkRe.exec(body);
    if (!m) return '(link not found)';
    const start = Math.max(0, m.index - 200);
    const end = Math.min(body.length, m.index + m[0].length + 200);
    return body.slice(start, end).replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  } catch {
    return '(read error)';
  }
}

async function sample() {
  const n = parseInt(flag('--n', '50'), 10);
  const out = flag('--out', 'classifier-calibration-worksheet.md');

  const db = await openEdgeDb(DB_FILE);
  const high = rowsToObjects(db.exec("SELECT * FROM edges WHERE confidence = 'high'"));
  const medium = rowsToObjects(db.exec("SELECT * FROM edges WHERE confidence = 'medium'"));
  db.close();

  if (high.length === 0 && medium.length === 0) {
    console.error('No edges in DB. Run backfill-edges.mjs first.');
    process.exit(1);
  }

  const highSample = shuffle(high).slice(0, n);
  const mediumSample = shuffle(medium).slice(0, n);

  let md = `# Edge Classifier Calibration Worksheet\n\n`;
  md += `Sample drawn: ${highSample.length} high-confidence + ${mediumSample.length} medium-confidence edges\n`;
  md += `Total in DB: ${high.length} high, ${medium.length} medium\n\n`;
  md += `For each edge, check ONE box:\n`;
  md += `- \`[x] correct\` — the edge type and direction are right\n`;
  md += `- \`[x] wrong-type\` — there is a real epistemic relationship but the type is wrong\n`;
  md += `- \`[x] wrong\` — no epistemic relationship; this should not be an edge at all\n\n`;
  md += `When done, run \`node scripts/calibrate-classifier.mjs score <this-file>\`\n\n`;
  md += `---\n\n`;

  function renderSection(title, items) {
    md += `## ${title} (${items.length} items)\n\n`;
    for (const e of items) {
      const ctx = extractContext(e.from_path, e.to_path);
      md += `### Edge ${e.id} - ${e.edge_type} (${e.confidence})\n\n`;
      md += `- **From:** \`${e.from_path}\`\n`;
      md += `- **To:** \`${e.to_path}\`\n`;
      md += `- **Context:** ${ctx}\n\n`;
      md += `- [ ] correct\n`;
      md += `- [ ] wrong-type\n`;
      md += `- [ ] wrong\n\n`;
      md += `---\n\n`;
    }
  }

  renderSection('High-confidence sample', highSample);
  renderSection('Medium-confidence sample', mediumSample);

  writeFileSync(out, md);
  console.log(`Wrote worksheet: ${out}`);
  console.log(`Sample sizes: ${highSample.length} high, ${mediumSample.length} medium`);
}

function score(file) {
  if (!file) {
    console.error('Usage: calibrate-classifier.mjs score <worksheet.md>');
    process.exit(1);
  }
  const text = readFileSync(file, 'utf-8');

  const sections = text.split(/^### Edge /m).slice(1);
  const stats = {
    high: { correct: 0, wrong_type: 0, wrong: 0, unlabeled: 0 },
    medium: { correct: 0, wrong_type: 0, wrong: 0, unlabeled: 0 },
    by_type: {},
  };

  for (const section of sections) {
    const idMatch = section.match(/^(\d+) - (\w+) \((\w+)\)/);
    if (!idMatch) continue;
    const edgeType = idMatch[2];
    const confidence = idMatch[3];

    const correct = /^- \[x\] correct/im.test(section);
    const wrongType = /^- \[x\] wrong-type/im.test(section);
    const wrong = /^- \[x\] wrong\b/im.test(section);

    let label;
    if (correct) label = 'correct';
    else if (wrongType) label = 'wrong_type';
    else if (wrong) label = 'wrong';
    else label = 'unlabeled';

    stats[confidence][label]++;
    if (!stats.by_type[edgeType]) stats.by_type[edgeType] = { correct: 0, wrong_type: 0, wrong: 0, unlabeled: 0 };
    stats.by_type[edgeType][label]++;
  }

  function precision(s) {
    const labeled = s.correct + s.wrong_type + s.wrong;
    if (labeled === 0) return null;
    return {
      labeled,
      precision_strict: s.correct / labeled,
      precision_loose: (s.correct + s.wrong_type) / labeled,
      unlabeled: s.unlabeled,
    };
  }

  console.log(JSON.stringify({
    high: { ...stats.high, ...(precision(stats.high) || {}) },
    medium: { ...stats.medium, ...(precision(stats.medium) || {}) },
    by_type: Object.fromEntries(
      Object.entries(stats.by_type).map(([k, v]) => [k, { ...v, ...(precision(v) || {}) }]),
    ),
  }, null, 2));
}

if (cmd === 'sample') {
  sample().catch(err => { console.error(err); process.exit(1); });
} else if (cmd === 'score') {
  score(args[1]);
} else {
  console.error('Usage: calibrate-classifier.mjs sample|score [args]');
  process.exit(1);
}
