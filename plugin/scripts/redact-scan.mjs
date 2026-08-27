#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SECRET_PATTERNS } from './lib/secret-patterns.mjs';

const TEXT_EXTENSIONS = new Set(['.jsonl', '.json', '.md', '.log', '.txt']);

// redact-scan REPORTS findings for human review, so it needs \b-anchored,
// narrower regexes than the shared SECRET_PATTERNS (tuned for a wide net on a
// hard block) — reusing those bodies verbatim here would flag ordinary
// hyphenated prose (e.g. "sk-learning-rate-was-set-to-low") as an openai-key.
// The scrubber keeps secrets out of new records; this scanner finds what
// earlier bugs already wrote. They are two halves of one promise, so the check
// below runs BOTH ways: no kind here may be absent from the shared vocabulary,
// and no shared kind may be missing a counterpart here. A one-way check let
// 'pem-key' live in the scrubber and not the scanner, so --redact reported
// clean on files holding private keys. 'openai-key' is the one documented
// exception: it covers a redact-scan-specific shape with no shared analogue.
const SCANNER_ONLY = new Set(['openai-key']);
const SHARED_KINDS = new Set(SECRET_PATTERNS.map((p) => p.kind));
const PATTERNS = [
  { kind: 'github-pat', re: /\bghp_[A-Za-z0-9]{30,}\b/g },
  { kind: 'openai-key', re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9]{16,}\b/g },
  { kind: 'anthropic-key', re: /\bsk-ant-api[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\b/g },
  { kind: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'stripe-key', re: /\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b/g },
  { kind: 'generic-sk-key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'cloudflare-pat', re: /\bcfpat-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'bearer-token', re: /Bearer\s+[A-Za-z0-9._\-\/+=]{20,}/g },
  {
    kind: 'pem-key',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
];
const SCANNER_KINDS = new Set(PATTERNS.map((p) => p.kind));
for (const { kind } of PATTERNS) {
  if (!SCANNER_ONLY.has(kind) && !SHARED_KINDS.has(kind)) {
    throw new Error(`redact-scan: kind '${kind}' has drifted from shared secret-patterns.mjs`);
  }
}
for (const kind of SHARED_KINDS) {
  if (!SCANNER_KINDS.has(kind)) {
    throw new Error(`redact-scan: shared kind '${kind}' has no scanner counterpart`);
  }
}

export const __test__ = { PATTERNS };

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    process.stderr.write('usage: redact-scan.mjs <file...>\n');
    process.exit(1);
  }
  let found = false;
  for (const p of paths) {
    if (!TEXT_EXTENSIONS.has(extname(p).toLowerCase())) {
      process.stderr.write(`redact-scan: skipping binary file ${p}\n`);
      continue;
    }
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
