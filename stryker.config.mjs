// stryker.config.mjs : one mutation target per run, picked by LL_MUTATE.
//
// bench/mutation.mjs runs every target in turn and fails if any of them drops
// below its break threshold. Each break sits a few points under the score the
// target's tests reached on their first run, so it records what they kill today
// rather than an aspiration.

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
      'plugin/hooks/session-start/context-assembly.mjs:62-86',
      'plugin/hooks/session-start/context-assembly.mjs:142-154',
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

const name = process.env.LL_MUTATE;
const target = TARGETS[name];

export default target && {
  testRunner: 'command',
  commandRunner: { command: `node --test ${target.tests.join(' ')}` },
  mutate: target.mutate,
  thresholds: { high: Math.min(target.break + 10, 100), low: target.break, break: target.break },
  reporters: ['clear-text', 'json'],
  jsonReporter: { fileName: `reports/mutation/${name}.json` },
  concurrency: 4,
  timeoutMS: 30000,
  coverageAnalysis: 'off',
  tempDirName: '.stryker-tmp',
};
