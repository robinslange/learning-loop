// Freeze the tail-probe sample. Sampling the live vault at run time made every
// arm a different question: notes written between runs changed which long notes
// were selected, so an 85% and a 71.7% for the same code were not comparable.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
const VAULT = '/Users/robin/brain/brain',
  CUT = 2400,
  TAKE = 320;
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
const longNotes = [];
for (const f of walk(VAULT)) {
  const body = strip(readFileSync(f, 'utf8'))
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1');
  if (Buffer.byteLength(body) > CUT + TAKE)
    longNotes.push({
      path: relative(VAULT, f),
      tail: body
        .slice(CUT, CUT + TAKE)
        .replace(/\s+/g, ' ')
        .trim(),
    });
}
longNotes.sort((a, b) => (a.path < b.path ? -1 : 1)); // stable order, not directory order
const stride = Math.max(1, Math.floor(longNotes.length / 60));
const sample = longNotes.filter((_, i) => i % stride === 0).slice(0, 60);
writeFileSync('tail-sample.json', JSON.stringify(sample, null, 1));
console.log(`froze ${sample.length} tail passages from ${longNotes.length} long notes`);
