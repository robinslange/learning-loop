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

// These files are hard-wrapped markdown prose. Matching them as written pins
// where the lines happen to break, not what they say — a reflow then fails a
// test about a claim that did not change. Collapse the whitespace first and
// assert on the sentence.
const flat = (text) => text.replace(/\s+/g, ' ');

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
  for (const [gap, pattern] of [
    // `link revoke` landed mid-plan and withdraws one half of one kind of
    // grant. The remaining three limits are what a reader would otherwise
    // round up to "revocation works".
    ['only the issuer can withdraw its own half', /only that machine can withdraw it/i],
    ['a follow cannot be withdrawn from here', /no way from here to withdraw a `follow`/i],
    [
      'an unscoped revocation deletes nothing',
      /An unscoped revocation deletes nothing, and a `link` is unscoped/,
    ],
    ['the reader-side check does not bound', /it is not a boundary/],
  ]) {
    assert.match(flat(unreleased), pattern, `the changelog must state the gap: ${gap}`);
  }
  // No lookahead games: the phrase is false for the main case whatever follows
  // it, and an assertion that only fires on one continuation is an assertion
  // with a hole shaped like every other continuation.
  assert.doesNotMatch(
    flat(unreleased),
    /revocation (removes|deletes) local data/i,
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
  // `ll-search link revoke` landed mid-plan, so the teardown can now withdraw
  // — but only the half this machine signed, and it deletes nothing from disk.
  // Each of those three is a separate claim and the skill has to carry all
  // three: a teardown that says "revoked" while the inbound half stands, or
  // that lets the sweep look optional because revoke ran, is worse than one
  // that says nothing.
  assert.ok(
    doc.includes('ll-search link revoke'),
    'uninstall must withdraw the links this machine issued',
  );
  assert.match(
    flat(doc),
    /only the half this machine signed/i,
    'a link is two grants; only the issuer can withdraw its own',
  );
  assert.match(
    flat(doc),
    /revoking deletes nothing from this disk/i,
    'a link is unscoped, so it names no cache to remove — the sweep is not optional',
  );
  // What still cannot be withdrawn from here, and for how long it survives.
  assert.match(flat(doc), /no way from here to withdraw a `follow`/i);
  // Matched across a line wrap: these are prose in a hard-wrapped markdown
  // file, so a literal with a newline in it pins the wrap, not the claim.
  for (const [what, fact] of [
    ['a follow', /ninety days for a `follow`/i],
    ['a link', /a year for a `link`/i],
  ]) {
    assert.match(flat(doc), fact, `uninstall must say how long ${what} survives the uninstall`);
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
