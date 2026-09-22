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

// Cascade-detection sentinels (*_SET) are internal by construction: they exist
// so one part of the code can tell "the operator set this" from "we defaulted
// it", not to be set directly. LL_SID, LL_REFLECT_SID and LL_CHILD_PID_FILE
// are session/test handshakes between plugin-owned processes, never something
// an operator is meant to set by hand. LL_SESSION_TMP_DIR and
// LL_AUTOLINK_ML_TIMEOUT_MS are marked "Test seam ... unset in production" in
// env.mjs itself.
const INTERNAL = new Set([
  'LL_SID',
  'LL_REFLECT_SID',
  'LL_CHILD_PID_FILE',
  'LL_SESSION_TMP_DIR',
  'LL_AUTOLINK_ML_TIMEOUT_MS',
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
  // *_SET sentinels are derived from `process.env.NAME !== undefined`, so the
  // regex above already produces both NAME and NAME_SET from the same line;
  // filter the sentinels out here rather than special-casing the regex.
  return [...names].filter((n) => !n.endsWith('_SET'));
}

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
