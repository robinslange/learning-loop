#!/usr/bin/env node
// recall-labels.mjs — positive labels for the gate, mined from conversations.
//
// The injection directive asks the model to say `Recall: <note title>` when it
// uses an injected note. Live-mode sessions therefore leave a usage signal in
// their own transcript, and transcript filenames are session ids, so it joins
// straight onto the shadow-injection stream.
//
// This is a far denser signal than the /reflect note-usage join (thousands of
// pairs against dozens) because it needs nothing but the session having
// happened. Two honest limits:
//
//   · A `Recall:` can come from the model's own vault search rather than from
//     the injection — CLAUDE.md asks for the same marker on manual retrieval.
//     That inflates absolute precision. It inflates BOTH arms identically
//     though, since the arms are scored on the same sessions, so the
//     comparison survives what the absolute number does not.
//   · Absence of a Recall is weak evidence of non-use: the model can use a note
//     silently. So this measures "demonstrably used", a lower bound.
//
// Usage: node bench/recall-labels.mjs [--out bench/baselines/recall-labels.json]

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const OUT = arg('--out', join(import.meta.dirname, 'baselines/recall-labels.json'));
const PROJECTS = arg('--projects', join(process.env.HOME, '.claude/projects'));
const pluginData =
  process.env.CLAUDE_PLUGIN_DATA ||
  join(process.env.HOME, '.claude/plugins/data/learning-loop-learning-loop-marketplace');

// Shortest slug prefix that may be treated as identifying a note. Titles get
// truncated ("a-judge-flips-eighty-four-percent...") and reworded, so exact
// equality misses real uses; but a short prefix would join unrelated notes that
// share an opening word. 25 characters is long enough that a collision needs
// several matching words.
const MIN_PREFIX = 25;

import { isFixturePrompt, isFixtureSession } from './fixtures.mjs';

const slugify = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

// --- injected pairs from the shadow stream (live mode only) ----------------
const dir = join(pluginData, 'retrieval');
const raw = [];
const promptsBySession = new Map();
for (const f of readdirSync(dir).filter((x) => x.startsWith('shadow-injection-'))) {
  for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
    if (!line) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (!r.session_id) continue;
    if (r.prompt) {
      if (!promptsBySession.has(r.session_id)) promptsBySession.set(r.session_id, []);
      promptsBySession.get(r.session_id).push(r.prompt);
    }
    // Shadow-mode records never reached the model, so they cannot be recalled
    // and must not dilute the denominator.
    if (r.mode !== 'live' || r.type !== 'gate-pass-payload') continue;
    for (const p of r.payload?.injected_paths || []) {
      raw.push({
        session_id: r.session_id,
        path: p.path,
        level: p.level,
        rank: r.payload.injected_paths.indexOf(p),
        ts: r.ts,
        rrf: r.gate?.vault_top_score ?? null,
        prompt: r.prompt || '',
      });
    }
  }
}

// Test traffic is live-mode too (the tests inherited injection_mode: live), and
// one test session holds 4510 of the 6122 live turns on record. Left in, it
// decides every number below.
const dropped = { sessions: 0, pairs: 0 };
const fixtureSessions = new Set(
  [...promptsBySession.entries()]
    .filter(([, prompts]) => isFixtureSession(prompts))
    .map(([sid]) => sid),
);
const injections = raw.filter((i) => {
  if (fixtureSessions.has(i.session_id) || isFixturePrompt(i.prompt)) {
    dropped.pairs++;
    return false;
  }
  return true;
});
dropped.sessions = fixtureSessions.size;
const sessions = new Set(injections.map((i) => i.session_id));

// --- Recall: mentions per session ------------------------------------------
function walk(d) {
  return readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)],
  );
}
const transcripts = new Map();
for (const f of walk(PROJECTS)) {
  if (!f.endsWith('.jsonl')) continue;
  const sid = basename(f, '.jsonl');
  if (sessions.has(sid)) transcripts.set(sid, f);
}

const recalledBySession = new Map();
for (const [sid, file] of transcripts) {
  const recalls = new Set();
  // Only assistant text carries the marker; scanning raw bytes would also pick
  // up the directive inside the injected user-turn context, which is the
  // instruction rather than a use.
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('Recall:')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== 'assistant') continue;
    const blocks = entry.message?.content;
    const texts =
      typeof blocks === 'string'
        ? [blocks]
        : Array.isArray(blocks)
          ? blocks.filter((b) => b.type === 'text').map((b) => b.text)
          : [];
    for (const t of texts) {
      for (const m of t.matchAll(/Recall:\s*([^\n]{4,120})/g)) {
        const raw = m[1].trim();
        if (raw.startsWith('<')) continue; // the directive's own placeholder
        recalls.add(slugify(raw));
      }
    }
  }
  recalledBySession.set(sid, [...recalls]);
}

// --- join -------------------------------------------------------------------
function isRecalled(sid, notePath) {
  const slugs = recalledBySession.get(sid);
  if (!slugs?.length) return false;
  const noteSlug = slugify(basename(notePath, '.md'));
  const key = noteSlug.slice(0, MIN_PREFIX);
  if (noteSlug.length < MIN_PREFIX) return slugs.some((s) => s.includes(noteSlug));
  return slugs.some((s) => s.includes(key) || noteSlug.startsWith(s.slice(0, MIN_PREFIX)));
}

const labelled = injections.map((i) => ({ ...i, recalled: isRecalled(i.session_id, i.path) }));
const used = labelled.filter((l) => l.recalled);

const byRank = {};
for (const l of labelled) {
  byRank[l.rank] ??= { n: 0, hit: 0 };
  byRank[l.rank].n++;
  if (l.recalled) byRank[l.rank].hit++;
}

writeFileSync(OUT, JSON.stringify(labelled, null, 1));

const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + '%' : 'n/a');
console.log('Recall-mined injection labels');
console.log('='.repeat(56));
console.log(`  dropped as fixture:   ${dropped.sessions} sessions, ${dropped.pairs} pairs`);
console.log(`  live sessions:        ${sessions.size} (${transcripts.size} with transcript)`);
console.log(
  `  sessions w/ a Recall: ${[...recalledBySession.values()].filter((v) => v.length).length}`,
);
console.log(`  injected pairs:       ${labelled.length}`);
console.log(`  demonstrably used:    ${used.length}  (${pct(used.length, labelled.length)})`);
console.log('\n  by rank:');
for (const [r, v] of Object.entries(byRank).sort((a, b) => a[0] - b[0])) {
  console.log(`    rank ${r}  ${pct(v.hit, v.n).padStart(6)}  (${v.hit}/${v.n})`);
}
console.log(`\nwrote ${OUT}`);
