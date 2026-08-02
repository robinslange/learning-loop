// Same 60 tail passages, but ranked by BM25 alone (the lane that HAS the full
// body). If BM25 finds what the funnel loses, the defect is fusion weighting,
// not truncation — and chunking would be fixing the wrong constraint.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
const VAULT = '/Users/robin/brain/brain',
  DB = process.argv[2];
const walk = (d) =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.name.startsWith('.') || e.name.startsWith('_')
      ? []
      : e.isDirectory()
        ? walk(join(d, e.name))
        : e.name.endsWith('.md')
          ? [join(d, e.name)]
          : [],
  );
const strip = (r) =>
  r.startsWith('---') ? r.slice(r.indexOf('\n', r.indexOf('\n---', 3) + 1) + 1) : r;
const CUT = 2400,
  TAKE = 320;
const longNotes = [];
for (const f of walk(VAULT)) {
  const body = strip(readFileSync(f, 'utf8'))
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1');
  if (Buffer.byteLength(body) > CUT + TAKE) longNotes.push({ path: relative(VAULT, f), body });
}
const stride = Math.max(1, Math.floor(longNotes.length / 60));
const sample = longNotes.filter((_, i) => i % stride === 0).slice(0, 60);
let r1 = 0,
  r5 = 0,
  r10 = 0,
  miss = 0;
for (const n of sample) {
  const terms = [
    ...new Set(
      n.body
        .slice(CUT, CUT + TAKE)
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 3),
    ),
  ].slice(0, 25);
  if (!terms.length) {
    miss++;
    continue;
  }
  const q = terms.join(' OR ');
  let paths = [];
  try {
    const sql = `SELECT n.path FROM notes_fts f JOIN notes n ON n.id=f.rowid WHERE notes_fts MATCH '${q.replace(/'/g, "''")}' ORDER BY bm25(notes_fts) LIMIT 10`;
    paths = execFileSync('sqlite3', [DB, sql], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean);
  } catch {}
  const rank = paths.indexOf(n.path);
  if (rank === 0) r1++;
  if (rank >= 0 && rank < 5) r5++;
  if (rank >= 0 && rank < 10) r10++;
  if (rank < 0) miss++;
}
const p = (x) => ((100 * x) / sample.length).toFixed(1) + '%';
console.log(`  rank 1: ${p(r1)}   top 5: ${p(r5)}   top 10: ${p(r10)}   missed: ${p(miss)}`);
