import { readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

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
