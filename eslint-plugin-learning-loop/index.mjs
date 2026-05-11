// eslint-plugin-learning-loop/index.mjs
// Local ESLint plugin for learning-loop conventions.
// All four rules are configured "off" in phase 0. Phase 1I (Track 1I) flips
// them to "error" once consumers have migrated to the new primitives.

import noProcessEnv from './rules/no-process-env-outside-env-module.mjs';
import noEmptyCatch from './rules/no-empty-catch.mjs';
import noDirectJsonparse from './rules/no-direct-jsonparse.mjs';
import noRawLockfile from './rules/no-raw-lockfile.mjs';

export default {
  meta: { name: 'eslint-plugin-learning-loop', version: '0.0.0' },
  rules: {
    'no-process-env-outside-env-module': noProcessEnv,
    'no-empty-catch': noEmptyCatch,
    'no-direct-jsonparse': noDirectJsonparse,
    'no-raw-lockfile': noRawLockfile,
  },
};
