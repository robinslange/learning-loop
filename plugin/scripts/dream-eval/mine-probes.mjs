import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { appendJsonlLine } from '../lib/jsonl.mjs';
import { DATA_PATHS } from '../lib/paths.mjs';

const FILLER = new Set(['uses', 'with', 'the', 'was', 'and', 'for', 'from']);

export function extractDistinctiveTokens(text) {
  const raw = text.match(/\b[A-Za-z][A-Za-z0-9.]{3,}\b|\b\d{3,}\b/g) || [];
  const seen = new Set();
  const out = [];
  for (const t of raw) {
    if (FILLER.has(t.toLowerCase())) continue;
    const distinctive = /[A-Z]/.test(t) || /\d/.test(t) || t.includes('.');
    if (!distinctive) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

export function mineReverse({ memoryDir, grep }) {
  const probes = [];
  for (const f of readdirSync(memoryDir)) {
    if (!f.endsWith('.md')) continue;
    const tokens = extractDistinctiveTokens(readFileSync(join(memoryDir, f), 'utf8'));
    for (const tok of tokens) {
      for (const { session, line } of grep(tok)) {
        probes.push({
          tier: 'reverse',
          question: line,
          expected_files: [basename(f)],
          source_session: session,
          confidence: 'low',
        });
      }
    }
  }
  return probes;
}

const PROBE_PATTERNS = [
  /\bit'?s\s+(.+?)\s+not\s+(.+)/i,
  /\bno,?\s+it'?s\s+actually\s+(.+)/i,
  /\bwhat\s+was\s+(.+?)\s+again\b/i,
  /\bwriting\s+rules\s+for\s+(.+)/i,
  /\b(?:remove all|never|always|no mention of)\s+(.+)/i,
];

function bindByToken(text, memoryDir) {
  const tokens = extractDistinctiveTokens(text);
  const hits = [];
  for (const f of readdirSync(memoryDir)) {
    if (!f.endsWith('.md')) continue;
    const body = readFileSync(join(memoryDir, f), 'utf8');
    if (tokens.some((t) => body.includes(t))) hits.push(basename(f));
  }
  return hits;
}

export function mineForward({ archiveLines, memoryDir }) {
  const probes = [];
  for (const { session, text } of archiveLines) {
    if (!PROBE_PATTERNS.some((re) => re.test(text))) continue;
    const expected = bindByToken(text, memoryDir);
    probes.push({
      tier: 'forward',
      question: text,
      expected_files: expected,
      source_session: session,
      confidence: expected.length ? 'high' : 'unbound',
    });
  }
  return probes;
}

function probeHash(p) {
  return createHash('sha1')
    .update(`${p.question}|${JSON.stringify(p.expected_files)}`)
    .digest('hex');
}

export function writeProbes(pd, probes) {
  const path = DATA_PATHS.dreamEvalProbes(pd);
  const seen = new Set();
  if (existsSync(path)) {
    for (const line of readFileSync(path, 'utf8').trim().split('\n')) {
      if (!line) continue;
      try {
        seen.add(probeHash(JSON.parse(line)));
        // eslint-disable-next-line learning-loop/no-empty-catch -- a malformed existing line is skipped, not fatal to the rest of the dedupe pass.
      } catch {}
    }
  }
  let appended = 0;
  for (const p of probes) {
    const h = probeHash(p);
    if (seen.has(h)) continue;
    seen.add(h);
    appendJsonlLine(path, { ...p, probe_id: h.slice(0, 12) });
    appended++;
  }
  return appended;
}
