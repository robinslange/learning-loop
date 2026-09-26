// tests/env-docs.test.mjs : every user-facing LL_*/LEARNING_LOOP_* var env.mjs
// reads must be documented in guide/configuration.md (GitHub issue #68).
//
// Keeps the gap from reopening: a var added to env.mjs without a doc entry
// fails this test instead of shipping silently undocumented. INTERNAL lists
// the handshake/test seams that are deliberately excluded -- everything else
// env.mjs reads must appear in the guide.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ENV_MJS_PATH = fileURLToPath(new URL('../plugin/scripts/lib/env.mjs', import.meta.url));
const CONFIG_DOC_PATH = fileURLToPath(new URL('../guide/configuration.md', import.meta.url));

// LL_REFLECT_SID and LL_CHILD_PID_FILE are
// session/test handshakes between plugin-owned processes, never something an
// operator is meant to set by hand. LL_SESSION_TMP_DIR,
// LL_AUTOLINK_ML_TIMEOUT_MS and LL_LEDGER_GIT_BUDGET_MS are marked "Test seam
// ... unset in production" in env.mjs itself.
const INTERNAL = new Set([
  'LL_REFLECT_SID',
  'LL_CHILD_PID_FILE',
  'LL_SESSION_TMP_DIR',
  'LL_AUTOLINK_ML_TIMEOUT_MS',
  'LL_LEDGER_GIT_BUDGET_MS',
]);

function envMjsVarNames() {
  const src = readFileSync(ENV_MJS_PATH, 'utf-8');
  const names = new Set();
  const re =
    /(?:pick|isTruthy|coerceNumber)\('((?:LL|LEARNING_LOOP)_[A-Z0-9_]+)'|process\.env\.((?:LL|LEARNING_LOOP)_[A-Z0-9_]+)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    names.add(m[1] || m[2]);
  }
  return [...names];
}

// INTERNAL exists to excuse real env.mjs vars from the doc check, not to
// carry its own list independent of what env.mjs actually reads. An entry
// for a var env.mjs never reads (e.g. a stale LL_SID left behind when the
// real handshake var was renamed to LL_REFLECT_SID) documents nothing and
// excuses nothing -- it is just dead weight that the next reader trusts.
test('every INTERNAL entry names a var env.mjs actually reads', () => {
  const names = new Set(envMjsVarNames());
  const dead = [...INTERNAL].filter((n) => !names.has(n));
  assert.deepEqual(dead, [], `INTERNAL lists vars env.mjs never reads: ${dead.join(', ')}`);
});

test('every non-internal env.mjs var is documented in guide/configuration.md', () => {
  const doc = readFileSync(CONFIG_DOC_PATH, 'utf-8');
  const names = envMjsVarNames();
  assert.ok(
    names.length > 10,
    'sanity check: the extraction regex should find double digits of vars',
  );

  const undocumented = names.filter((n) => !INTERNAL.has(n) && !doc.includes(n));
  assert.deepEqual(
    undocumented,
    [],
    `env.mjs reads these vars but guide/configuration.md never mentions them: ${undocumented.join(', ')}`,
  );
});
