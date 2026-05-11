// eslint.config.mjs -- flat config for learning-loop (ESLint 9+).
//
// Phase 0 (Track 0C): four custom rules are registered but configured "off".
// Phase 1 (Track 1I): flips them to "error" after consumers migrate to the
// new primitives in scripts/lib/{env,file-lock,safe-load}.mjs.

import learningLoopPlugin from './eslint-plugin-learning-loop/index.mjs';

export default [
  {
    files: ['hooks/**/*.{js,mjs}', 'scripts/**/*.{js,mjs}'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    plugins: {
      'learning-loop': learningLoopPlugin,
    },
    rules: {
      'learning-loop/no-process-env-outside-env-module': 'error',
      'learning-loop/no-empty-catch': 'error',
      'learning-loop/no-direct-jsonparse': 'error',
      'learning-loop/no-raw-lockfile': 'error',
    },
  },
  {
    ignores: [
      'node_modules/**',
      '.worktrees/**',
      'native/**',
      'vendor/**',
      'scripts/lib/vendor/**',
      'data/**',
      'provenance/**',
      'docs/**',
      'tests/fixtures/**',
    ],
  },
];
