#!/usr/bin/env node

import { readFileSync } from 'node:fs';

const PATTERNS = [
  { kind: 'github-pat', re: /\bghp_[A-Za-z0-9]{30,}\b/g },
  { kind: 'openai-key', re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9]{16,}\b/g },
  { kind: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\b/g },
];

export function scanForSecrets(text) {
  const hits = [];
  if (!text) return hits;
  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      hits.push({ kind, match: m[0], index: m.index });
    }
  }
  return hits;
}

function maskSecret(s) {
  if (s.length <= 6) return '***';
  return s.slice(0, 4) + '*'.repeat(s.length - 6) + s.slice(-2);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    process.stderr.write('usage: redact-scan.mjs <file...>\n');
    process.exit(1);
  }
  let found = false;
  for (const p of paths) {
    let text;
    try {
      text = readFileSync(p, 'utf-8');
    } catch (err) {
      process.stderr.write(`redact-scan: cannot read ${p}: ${err.message}\n`);
      continue;
    }
    const hits = scanForSecrets(text);
    if (hits.length > 0) {
      found = true;
      for (const h of hits) {
        process.stdout.write(`${p}: ${h.kind} ${maskSecret(h.match)}\n`);
      }
    }
  }
  process.exit(found ? 1 : 0);
}
