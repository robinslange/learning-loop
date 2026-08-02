// Can a passage from a long note's TAIL retrieve that note?
// This is what chunking would fix. Queries are taken from past the 512-token
// cut, so the dense lane has never seen this text for these notes.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

const VAULT = '/Users/robin/brain/brain';
const DB = process.argv[2];
const BIN = process.argv[3];
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

// ~4 bytes/token: sample well past the cut so the vector provably lacks it.
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
  const tail = n.body
    .slice(CUT, CUT + TAKE)
    .replace(/\s+/g, ' ')
    .trim();
  let hits = [];
  try {
    const out = execFileSync(BIN, ['query', '--top', '10', DB, tail], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const j = JSON.parse(out);
    hits = (Array.isArray(j) ? j : j.results || []).map((h) => h.path);
  } catch {}
  const rank = hits.indexOf(n.path);
  if (rank === 0) r1++;
  if (rank >= 0 && rank < 5) r5++;
  if (rank >= 0 && rank < 10) r10++;
  if (rank < 0) miss++;
}
const p = (x) => ((100 * x) / sample.length).toFixed(1) + '%';
console.log(`  tail-passage queries: ${sample.length} long notes`);
console.log(`  source note at rank 1:      ${p(r1)}`);
console.log(`  source note in top 5:       ${p(r5)}`);
console.log(`  source note in top 10:      ${p(r10)}`);
console.log(`  not found at all:           ${p(miss)}`);
