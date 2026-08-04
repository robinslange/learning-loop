// eslint-plugin-learning-loop/index.mjs
// Local ESLint plugin for learning-loop conventions.
// Five rules. `no-raw-lockfile` and `no-url-pathname` run at "error";
// `no-process-env-outside-env-module`, `no-empty-catch` and `no-direct-jsonparse`
// are still "off" pending consumer migration — each currently fails on shipped
// code. See eslint.config.mjs for the live settings and ARCHITECTURE.md
// ("critical invariants") for what that means for the invariants they back.

import noProcessEnv from './rules/no-process-env-outside-env-module.mjs';
import noEmptyCatch from './rules/no-empty-catch.mjs';
import noDirectJsonparse from './rules/no-direct-jsonparse.mjs';
import noRawLockfile from './rules/no-raw-lockfile.mjs';
import noUrlPathname from './rules/no-url-pathname.mjs';

export default {
  meta: { name: 'eslint-plugin-learning-loop', version: '0.0.0' },
  rules: {
    'no-process-env-outside-env-module': noProcessEnv,
    'no-empty-catch': noEmptyCatch,
    'no-direct-jsonparse': noDirectJsonparse,
    'no-raw-lockfile': noRawLockfile,
    'no-url-pathname': noUrlPathname,
  },
};
