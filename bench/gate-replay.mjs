#!/usr/bin/env node
// gate-replay.mjs — re-score real logged prompts with today's binary.
//
// Produces the raw material for the gate A/B: for each prompt, the RRF fusion
// score the live gate reads and the cross-encoder score of the same query's
// best candidate. Nothing is judged here; scoring and analysis are separate so
// the expensive half runs once.
//
// The query is rebuilt with the hook's OWN buildQueryParts, including the
// prior-message padding it applies to short prompts, reconstructed from the
// session's earlier logged prompts. Replaying the bare prompt would feed the
// scorer a cleaner input than production sends, and the padded 19% is exactly
// where the gate misbehaves.
//
// Usage: node bench/gate-replay.mjs --sample 400 --out bench/baselines/replay.jsonl

import { readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildQueryParts } from '../plugin/hooks/lib/inject.mjs';
import { HookConfig } from '../plugin/scripts/lib/hook-config.mjs';
import { CONTROL_PROMPTS } from './control-prompts.mjs';

const execFileP = promisify(execFile);

const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const SAMPLE = Number(arg('--sample', 400));
const OUT = arg('--out', 'bench/baselines/replay.jsonl');
const CANDIDATES = Number(arg('--candidates', String(HookConfig.INJECTION_RERANK_CANDIDATES)));
const CONCURRENCY = Number(arg('--concurrency', '4'));

const pluginData =
  process.env.CLAUDE_PLUGIN_DATA ||
  join(process.env.HOME, '.claude/plugins/data/learning-loop-learning-loop-marketplace');
const BIN = arg('--bin', join(import.meta.dirname, '..', 'native/target/release/ll-search'));
const DB = arg('--db', join(process.env.HOME, 'brain/brain/.vault-search/vault-index.db'));

// Test-suite prompts reach the production stream (fixed in 97d6bfa, but the
// historical records remain). Derive the list from the test source so it tracks
// the tests rather than rotting in a copy.
function fixturePrompts() {
  const src = readFileSync(join(import.meta.dirname, '..', 'tests/session-label.test.mjs'), 'utf8');
  const out = new Set();
  for (const m of src.matchAll(/['"`]([^'"`\n]{15,200})['"`]/g)) {
    const s = m[1];
    if (/^[/.~]/.test(s) || /^[A-Z_]+$/.test(s) || s.includes('${')) continue;
    out.add(s.slice(0, 40));
  }
  return [...out];
}
const FIXTURES = fixturePrompts();
const isFixture = (p) => FIXTURES.some((f) => (p || '').startsWith(f));

// --- corpus: per-session prompt sequences, in order ------------------------
const dir = join(pluginData, 'retrieval');
const sessions = new Map();
for (const f of readdirSync(dir)
  .filter((x) => x.startsWith('shadow-injection-'))
  .sort()) {
  for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
    if (!line) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (!r.session_id || !r.prompt) continue;
    if (!sessions.has(r.session_id)) sessions.set(r.session_id, []);
    // Fast-path-skipped prompts are kept: they are real user turns and the
    // hook's padding draws on them, even though they never reach the gate.
    sessions.get(r.session_id).push({ ts: r.ts, prompt: r.prompt, type: r.type });
  }
}
for (const seq of sessions.values()) seq.sort((a, b) => (a.ts < b.ts ? -1 : 1));

// Candidates: real prompts that reached the gate, with their session position
// so padding can be reconstructed.
const candidates = [];
const seenPrompt = new Set();
for (const [sid, seq] of sessions) {
  seq.forEach((turn, i) => {
    if (turn.type === 'gate-fail-fast-path') return;
    if (isFixture(turn.prompt) || seenPrompt.has(turn.prompt)) return;
    seenPrompt.add(turn.prompt);
    candidates.push({ sid, index: i, prompt: turn.prompt });
  });
}

// Deterministic stride, not a random sample: the run must be reproducible for
// a before/after comparison.
const stride = Math.max(1, Math.floor(candidates.length / SAMPLE));
const chosen = candidates.filter((_, i) => i % stride === 0).slice(0, SAMPLE);

const work = [
  ...chosen.map((c) => {
    const seq = sessions.get(c.sid);
    // buildQueryParts reads messages.slice(-3, -1) as "the two turns before
    // this one", so the array must end with the current prompt.
    const messages = seq.slice(Math.max(0, c.index - 3), c.index).map((t) => t.prompt);
    messages.push(c.prompt);
    return { source: 'real', prompt: c.prompt, messages };
  }),
  // Controls are standalone substantive questions in domains the vault has no
  // notes on. No padding: a control is a fresh first turn, which is also the
  // most favourable case for the gate.
  ...CONTROL_PROMPTS.map((p) => ({ source: 'control', prompt: p, messages: [p] })),
];

async function scoreOne(item) {
  const { query, padded } = buildQueryParts({
    prompt: item.prompt,
    messages: item.messages,
    soloMinChars: HookConfig.QUERY_SOLO_MIN_CHARS,
  });
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: pluginData };
  const out = { source: item.source, prompt: item.prompt, padded, query_len: query.length };

  try {
    const { stdout } = await execFileP(BIN, ['query', '--top', '5', DB, query], { env });
    const j = JSON.parse(stdout);
    const hits = Array.isArray(j) ? j : j.results || [];
    out.rrf = hits[0]?.score ?? null;
    out.rrf_top = hits[0]?.path ?? null;
  } catch (err) {
    out.rrf_error = err.code ?? String(err.message).slice(0, 80);
  }

  try {
    const { stdout } = await execFileP(
      BIN,
      ['rerank', DB, query, '--top', '5', '--candidates', String(CANDIDATES)],
      { env },
    );
    const j = JSON.parse(stdout);
    out.ce = j[0]?.score ?? null;
    out.ce_top = j[0]?.path ?? null;
  } catch (err) {
    out.ce_error = err.code ?? String(err.message).slice(0, 80);
  }
  return out;
}

writeFileSync(OUT, '');
let done = 0;
const queue = [...work];
async function worker() {
  for (;;) {
    const item = queue.shift();
    if (!item) return;
    const row = await scoreOne(item);
    appendFileSync(OUT, JSON.stringify(row) + '\n');
    if (++done % 25 === 0 || done === work.length) {
      process.stderr.write(`  ${done}/${work.length}\n`);
    }
  }
}
process.stderr.write(
  `Replaying ${chosen.length} real prompts + ${CONTROL_PROMPTS.length} controls ` +
    `(of ${candidates.length} distinct real prompts available)\n`,
);
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
process.stderr.write(`wrote ${OUT}\n`);
