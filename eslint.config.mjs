// eslint.config.mjs -- flat config for learning-loop (ESLint 9+).
//
// Three custom rules are registered but configured "off": running them at
// "error" still reports violations in hooks/ and scripts/ (18x process.env,
// 9x empty catch, 8x direct JSON.parse as of W4). Flip each rule to "error"
// once its consumers migrate to scripts/lib/{env,file-lock,safe-load}.mjs.
// no-raw-lockfile is at "error": it had zero violations when W4 wired eslint.

import learningLoopPlugin from './eslint-plugin-learning-loop/index.mjs';

export default [
  {
    files: ['plugin/hooks/**/*.{js,mjs}', 'plugin/scripts/**/*.{js,mjs}'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    plugins: {
      'learning-loop': learningLoopPlugin,
    },
    rules: {
      'learning-loop/no-process-env-outside-env-module': 'off',
      'learning-loop/no-empty-catch': 'off',
      'learning-loop/no-direct-jsonparse': 'off',
      'learning-loop/no-raw-lockfile': 'error',
      'learning-loop/no-url-pathname': 'error',
      'learning-loop/no-handwritten-trust-envelope': 'error',
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
