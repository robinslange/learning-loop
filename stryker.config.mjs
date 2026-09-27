// stryker.config.mjs : one Stryker run for the mutation target LL_MUTATE names.
// Targets live in bench/mutation-targets.mjs; npm run test:mutation runs them all.

import { TARGETS } from './bench/mutation-targets.mjs';

const name = process.env.LL_MUTATE;
if (!Object.hasOwn(TARGETS, name ?? '')) {
  throw new Error(
    `LL_MUTATE must name a target in bench/mutation-targets.mjs (${Object.keys(TARGETS).join(', ')}), got ${name}. npm run test:mutation runs them all.`,
  );
}
const target = TARGETS[name];

export default {
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
