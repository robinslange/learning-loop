// tests/docs-federation-checks.test.mjs
// The 2026-07 outage lasted two months because the client was content and
// nothing looked at the hub. Every place a person goes when they suspect
// something is wrong — doctor, health — has to name the four signals that
// would have caught it, and the teardown skill has to say what leaving does
// and does not remove.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const SKILLS = join(ROOT, 'plugin', 'skills');

test('doctor documents the four federation checks', () => {
  const doc = readFileSync(join(SKILLS, 'doctor', 'SKILL.md'), 'utf8');
  const missing = [
    'sync-state.json',
    'hub holds: nothing',
    'expiring within 14 days',
    'last successful sync',
  ].filter((check) => !doc.includes(check));
  assert.deepEqual(missing, [], `doctor must check: ${missing.join(', ')}`);
});

test('doctor says the federation checks are not in the health-check JSON', () => {
  const doc = readFileSync(join(SKILLS, 'doctor', 'SKILL.md'), 'utf8');
  assert.match(
    doc,
    /health-check\.mjs`? does not cover federation/,
    'health-check.mjs emits no federation row; a doctor that implies otherwise ' +
      'sends a reader looking for a check that never ran',
  );
});

test('uninstall clears the peer caches and says the grants outlive it', () => {
  const doc = readFileSync(join(SKILLS, 'uninstall', 'SKILL.md'), 'utf8');
  assert.ok(
    doc.includes('federation/data/peers'),
    "uninstall must delete the cached peer indices — they are other people's notes, " +
      'and nothing else on the machine will remove them',
  );
  // The teardown this plan was written to describe — revoke, then sweep — is
  // not available: `ClientMsg::RevokeGrant` exists in the protocol enum and
  // has no production sender, and there is no `link revoke` subcommand. A
  // skill that said "revoke" would name a command that does not exist. So the
  // requirement here is the opposite one: say that the grants survive, and
  // say for how long.
  assert.match(
    doc,
    /does not withdraw anything/i,
    'uninstall must say that removing the plugin revokes nothing',
  );
  for (const fact of ['a year for a `link`', 'ninety days for a `follow`']) {
    assert.ok(doc.includes(fact), `uninstall must say how long an orphaned grant lives: ${fact}`);
  }
});

test('health carries the same signals, and defers the rest to doctor', () => {
  const doc = readFileSync(join(SKILLS, 'health', 'SKILL.md'), 'utf8');
  const missing = ['sync-state.json', 'hub holds: nothing', 'STALE', 'BLOCKED'].filter(
    (check) => !doc.includes(check),
  );
  assert.deepEqual(missing, [], `health must surface: ${missing.join(', ')}`);
  assert.ok(
    doc.includes('/learning-loop:doctor'),
    'health is the lighter read; it must point at doctor for the full section',
  );
});
