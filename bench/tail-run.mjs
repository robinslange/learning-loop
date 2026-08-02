// Score the frozen sample. arg1: 'funnel <db> <bin>' or 'bm25 <db>'
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const [mode, DB, BIN] = process.argv.slice(2);
const sample = JSON.parse(readFileSync('tail-sample.json', 'utf8'));
let r1 = 0,
  r5 = 0,
  r10 = 0,
  miss = 0;
for (const n of sample) {
  let paths = [];
  try {
    if (mode === 'funnel') {
      const out = execFileSync(BIN, ['query', '--top', '10', DB, n.tail], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const j = JSON.parse(out);
      paths = (Array.isArray(j) ? j : j.results || []).map((h) => h.path);
    } else {
      const terms = [
        ...new Set(
          n.tail
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter((w) => w.length > 3),
        ),
      ].slice(0, 25);
      const sql = `SELECT n.path FROM notes_fts f JOIN notes n ON n.id=f.rowid WHERE notes_fts MATCH '${terms.join(' OR ').replace(/'/g, "''")}' ORDER BY bm25(notes_fts) LIMIT 10`;
      paths = execFileSync('sqlite3', [DB, sql], { encoding: 'utf8' })
        .trim()
        .split('\n')
        .filter(Boolean);
    }
  } catch {}
  const rank = paths.indexOf(n.path);
  if (rank === 0) r1++;
  if (rank >= 0 && rank < 5) r5++;
  if (rank >= 0 && rank < 10) r10++;
  if (rank < 0) miss++;
}
const p = (x) => ((100 * x) / sample.length).toFixed(1) + '%';
console.log(
  `  rank1 ${p(r1).padStart(6)}   top5 ${p(r5).padStart(6)}   top10 ${p(r10).padStart(6)}   missed ${p(miss).padStart(6)}`,
);
