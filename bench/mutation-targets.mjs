// bench/mutation-targets.mjs : what each mutation target mutates, the tests
// that must kill its mutants, and the score below which the run breaks.
//
// stryker.config.mjs builds one Stryker run from the entry LL_MUTATE names, and
// bench/mutation.mjs runs them all. Each break sits 3 points under the score the
// target's tests reached on their first run, so it records what they kill today
// rather than an aspiration.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const CONTEXT_ASSEMBLY = 'plugin/hooks/session-start/context-assembly.mjs';

// Stryker's file:start-end range for the functions from the one declared by
// `first` through the one declared by `last`, each ending at its column-0
// brace. Found by declaration, so an edit above them can't slide the range
// onto other code, and a renamed function throws here instead.
function functionLines(file, first, last = first) {
  const lines = readFileSync(join(ROOT, file), 'utf8').split(/\r?\n/);
  const at = (decl) => {
    const i = lines.findIndex((l) => l.startsWith(decl));
    if (i === -1) throw new Error(`${file}: no line starts with "${decl}"`);
    return i;
  };
  const end = lines.indexOf('}', at(last));
  return `${file}:${at(first) + 1}-${end + 1}`;
}

export const TARGETS = {
  'file-lock': {
    mutate: ['plugin/scripts/lib/file-lock.mjs'],
    tests: ['tests/lib-file-lock.test.mjs', 'tests/lib-file-lock-error-surface.test.mjs'],
    break: 72,
  },
  'cite-extract': {
    mutate: ['plugin/scripts/lib/cite-extract.mjs'],
    tests: ['tests/lib-cite-extract.test.mjs'],
    break: 60,
  },
  'edge-classifier': {
    mutate: ['plugin/scripts/lib/edge-classifier.mjs'],
    tests: ['tests/edge-classifier-direction.test.mjs', 'tests/edge-classifier-classify.test.mjs'],
    break: 54,
  },
  inject: {
    mutate: ['plugin/hooks/lib/inject.mjs'],
    tests: ['tests/inject.test.mjs', 'tests/session-label.test.mjs'],
    break: 75,
  },
  'artifact-verify': {
    mutate: ['plugin/scripts/lib/artifact-verify.mjs'],
    tests: ['tests/artifact-verify.test.mjs'],
    break: 94,
  },
  // What keeps secrets and denied terms out of a harvest bundle or a seed.
  scrub: {
    mutate: ['plugin/scripts/lib/secret-patterns.mjs', 'plugin/scripts/lib/deny-match.mjs'],
    tests: [
      'tests/lib-deny-match.test.mjs',
      'tests/redact-scan.test.mjs',
      'tests/harvest-scrub.test.mjs',
      'tests/seed-select.test.mjs',
    ],
    break: 37,
  },
  'frontmatter-schema': {
    mutate: ['plugin/scripts/lib/frontmatter-schema.mjs'],
    tests: ['tests/lib-frontmatter-schema.test.mjs'],
    break: 62,
  },
  // Only the pure exports: federationLine (with its hubText helper) and
  // shippedIntentionContexts. The rest of the file is I/O.
  'context-assembly': {
    mutate: [
      functionLines(CONTEXT_ASSEMBLY, 'function hubText(', 'export function federationLine('),
      functionLines(CONTEXT_ASSEMBLY, 'export function shippedIntentionContexts('),
    ],
    tests: [
      'tests/session-start-federation-line.test.mjs',
      'tests/session-start-pack-telemetry.test.mjs',
    ],
    break: 82,
  },
  'retrieval-usage': {
    mutate: ['plugin/scripts/lib/retrieval-usage.mjs'],
    tests: ['tests/retrieval-usage.test.mjs'],
    break: 65,
  },
  'pre-write-check': {
    mutate: ['plugin/hooks/pre-write-check.js'],
    tests: [
      'tests/pre-write-check.test.mjs',
      'tests/pre-write-check-duplicate-gate.test.mjs',
      'tests/pre-write-check-duplicate-flag-queue.test.mjs',
    ],
    break: 57,
  },
};
