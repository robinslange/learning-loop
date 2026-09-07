// tests/docs-no-dead-flow.test.mjs
// Federation v5 deleted the pre-v5 onboarding flow: there is no application
// form, no redeem POST, no headscale auth key, no `tailscale up`, and no
// `peer_id` — a principal is its Ed25519 key and a corpus is a `vault_id`.
// A file that still names one of those sends a person to a step that cannot
// be completed, which is worse than saying nothing.
//
// The sweep is exclusion-based; `helpers/published-docs.mjs` carries the
// argument for why, and the exclusions with their reasons.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, excludedBy, publishedFiles, rottedExclusions } from './helpers/published-docs.mjs';

const DEAD = [
  'tailscale',
  'headscale',
  '--auth-key',
  '/api/redeem',
  'redeem URL',
  'peer_id',
  '--peer-id',
  'LL_PEER_ID',
];

// Case-insensitively: the surviving reference this test first shipped without
// catching was a prose "check Tailscale and hub endpoint", capitalised. A
// needle list that only matches one casing is a list with a hole in it.
const hits = (text) => DEAD.filter((needle) => text.toLowerCase().includes(needle));

const swept = () => publishedFiles('*.md', '*.mjs', '*.js');

test('the sweep reaches the trees a reader actually opens', () => {
  // Without this, an empty or broken listing makes the assertion below pass
  // for the wrong reason — which is the exact failure the include list had.
  const files = swept();
  assert.ok(files.length > 100, `swept only ${files.length} files`);
  for (const expected of [
    'ARCHITECTURE.md',
    'README.md',
    'guide/federation.md',
    'plugin/skills/federation/SKILL.md',
    'plugin/hooks/session-start/context-assembly.mjs',
    'docs/baseline/rust.md',
  ]) {
    assert.ok(files.includes(expected), `the sweep must reach ${expected}`);
  }
});

test('every exclusion states a reason, and the reason still applies', () => {
  for (const [rel, why] of [
    ['CHANGELOG.md', 'a historical record names what it removed'],
    ['plugin/vendor/sql-wasm.js', 'vendored third-party'],
    ['tests/docs-no-dead-flow.test.mjs', 'a guard must be able to name what it forbids'],
  ]) {
    assert.equal(excludedBy(rel)?.why, why, `${rel} must be excluded for a stated reason`);
  }
  // An exclusion naming a path that has been deleted or renamed reads as
  // coverage and provides none.
  assert.deepEqual(rottedExclusions(), []);
});

test('nothing this repository publishes references the pre-v5 onboarding flow', () => {
  const offenders = [];
  for (const rel of swept()) {
    for (const needle of hits(readFileSync(join(ROOT, rel), 'utf8'))) {
      offenders.push(`${rel}: ${needle}`);
    }
  }
  assert.deepEqual(offenders, [], `stale references:\n${offenders.join('\n')}`);
});
