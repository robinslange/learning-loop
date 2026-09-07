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

test('architecture describes keys, vaults and grants', () => {
  const doc = readFileSync(join(ROOT, 'ARCHITECTURE.md'), 'utf8');
  for (const noun of [/\bkey\b/i, /\bvaults?\b/i, /\bgrants?\b/i, /\bvault_id\b/]) {
    assert.match(doc, noun, `architecture must describe federation as ${noun}`);
  }
  assert.doesNotMatch(doc, /tailnet|tailscale/i, 'the overlay network is gone');
});

test('architecture does not present the reader-side filter as a boundary', () => {
  // `search/federation.rs` says in its own doc comment that this is a
  // narrowing and not an authorization boundary, because an unscoped `link`
  // covers every cache on a linked machine. A document that read as
  // "revocation is complete" would contradict the code it describes.
  const doc = readFileSync(join(ROOT, 'ARCHITECTURE.md'), 'utf8');
  assert.match(
    doc,
    /not an authorization boundary/i,
    'architecture must say the peer-cache read check narrows and does not bound',
  );
});

test('the changelog states the revocation gap rather than claiming it closed', () => {
  const doc = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
  const unreleased = doc.slice(doc.indexOf('## Unreleased'), doc.indexOf('## v1.41.1'));
  assert.ok(unreleased.includes('Federation v5'), 'the v5 entry belongs under Unreleased');

  // The three facts. A changelog is what a person believes without checking,
  // so this is the one place an overstatement costs the most.
  for (const gap of [
    'Nothing in this client can revoke anything',
    'An unscoped revocation deletes nothing, and a `link` is unscoped',
    'it is not a boundary',
  ]) {
    assert.ok(unreleased.includes(gap), `the changelog must state the gap: ${gap}`);
  }
  assert.doesNotMatch(
    unreleased,
    /revocation (removes|deletes) local data(?! )/i,
    'a bare claim that revocation removes local data would be false for the main case',
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
