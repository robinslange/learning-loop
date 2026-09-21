// eslint.config.mjs -- flat config for learning-loop (ESLint 9+).
//
// Two custom rules are still registered but configured "off": running them at
// "error" still reports violations in hooks/ and scripts/ (18x process.env,
// 8x direct JSON.parse as of W4). Flip each rule to "error" once its
// consumers migrate to scripts/lib/{env,safe-load}.mjs.
// no-raw-lockfile, no-url-pathname, no-handwritten-trust-envelope,
// no-raw-telemetry-append and no-empty-catch are at "error": each had zero
// violations (after fixing shipped code, for no-empty-catch) when flipped on.
// no-empty-catch exempts scripts/lib/log.mjs, scripts/lib/safe-load.mjs and
// scripts/lib/file-lock.mjs, which intentionally use bare catches as
// error-absorbing boundaries; see rules/no-empty-catch.mjs.

import learningLoopPlugin from './eslint-plugin-learning-loop/index.mjs';

export default [
  {
    files: [
      'plugin/hooks/**/*.{js,mjs}',
      'plugin/scripts/**/*.{js,mjs}',
      'plugin/plugins/**/*.{js,mjs}',
    ],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    plugins: {
      'learning-loop': learningLoopPlugin,
    },
    rules: {
      'learning-loop/no-process-env-outside-env-module': 'off',
      'learning-loop/no-empty-catch': 'error',
      'learning-loop/no-direct-jsonparse': 'off',
      'learning-loop/no-raw-lockfile': 'error',
      'learning-loop/no-url-pathname': 'error',
      'learning-loop/no-handwritten-trust-envelope': 'error',
      'learning-loop/no-raw-telemetry-append': 'error',
    },
  },
  {
    ignores: [
      'node_modules/**',
      '.worktrees/**',
      '.claude/**',
      'native/**',
      'plugin/vendor/**',
      'plugin/scripts/lib/vendor/**',
      'data/**',
      'provenance/**',
      'docs/**',
      'tests/fixtures/**',
      // Workflow-tool scripts: the runtime wraps the body in an async function,
      // so they legitimately mix `export const meta` with top-level `return` —
      // a shape ESLint's module parser (like `node --check`) cannot parse.
      'plugin/skills/**/workflow.js',
    ],
  },
];
