// tests/docs-no-dead-flow.test.mjs
// Federation v5 deleted the pre-v5 onboarding flow: there is no application
// form, no redeem POST, no headscale auth key, no `tailscale up`, and no
// `peer_id` — a principal is its Ed25519 key and a corpus is a `vault_id`.
// A shipped file that still names one of those sends a person to a step that
// cannot be completed, which is worse than saying nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const PLUGIN = join(ROOT, 'plugin');

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

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'vendor' || e.name === 'node_modules' ? [] : walk(p);
    return /\.(md|mjs|js)$/.test(e.name) ? [p] : [];
  });
}

test('no shipped plugin file references the pre-v5 onboarding flow', () => {
  const offenders = [];
  for (const file of walk(PLUGIN)) {
    for (const needle of hits(readFileSync(file, 'utf8'))) {
      offenders.push(`${relative(ROOT, file)}: ${needle}`);
    }
  }
  assert.deepEqual(offenders, [], `stale references:\n${offenders.join('\n')}`);
});

test('the root docs a reader starts from reference the pre-v5 flow nowhere either', () => {
  const offenders = [];
  for (const name of ['ARCHITECTURE.md', 'README.md']) {
    for (const needle of hits(readFileSync(join(ROOT, name), 'utf8'))) {
      offenders.push(`${name}: ${needle}`);
    }
  }
  assert.deepEqual(offenders, [], `stale references:\n${offenders.join('\n')}`);
});
