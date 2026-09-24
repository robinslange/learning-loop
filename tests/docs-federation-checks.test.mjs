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
import { CHECK_IDS } from '../plugin/scripts/lib/health-checks/types.mjs';

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

test('doctor names every federation check health-check.mjs actually runs', () => {
  // This pinned the prose "health-check.mjs does not cover federation" until
  // `federation-sync-health` was added to CHECK_IDS and implemented in
  // quick.mjs. The sentence became false and the test went on enforcing it,
  // which is the failure mode of asserting a claim instead of deriving it:
  // the doc-lint kept the documentation wrong on purpose.
  //
  // Derived from CHECK_IDS, so a second federation check has to be documented
  // the day it is added, and a check that is removed stops being required.
  const doc = readFileSync(join(SKILLS, 'doctor', 'SKILL.md'), 'utf8');
  const federationChecks = Object.keys(CHECK_IDS).filter((id) => id.includes('federation'));

  assert.ok(
    federationChecks.length > 0,
    'CHECK_IDS declares no federation check; if that is deliberate this test ' +
      'should be asserting the doc says so, not passing vacuously',
  );
  const undocumented = federationChecks.filter((id) => !doc.includes(id));
  assert.deepEqual(
    undocumented,
    [],
    `doctor must name the federation checks health-check.mjs runs: ${undocumented.join(', ')}`,
  );
});

test('doctor still says its own federation checks are not in that JSON', () => {
  // The other half. Naming `federation-sync-health` must not leave a reader
  // thinking the whole of Step 4.5 appears in the health-check output — it is
  // one signal, and the rest are manual.
  const doc = readFileSync(join(SKILLS, 'doctor', 'SKILL.md'), 'utf8');
  assert.match(
    flat(doc),
    /NOT in that JSON|does not cover federation/,
    'doctor must say which federation checks the reader has to run by hand',
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
  const start = doc.indexOf('\n## v2.0.0\n');
  const section = doc.slice(start, doc.indexOf('\n## ', start + 1));
  assert.ok(section.includes('### Federation v5'), 'the v5 entry belongs under v2.0.0');

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
    assert.match(flat(section), pattern, `the changelog must state the gap: ${gap}`);
  }
  // No lookahead games: the phrase is false for the main case whatever follows
  // it, and an assertion that only fires on one continuation is an assertion
  // with a hole shaped like every other continuation.
  assert.doesNotMatch(
    flat(section),
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

test('nothing in the plugin tells a user to rotate an identity', () => {
  // Nothing rotates one. The seed IS the key, no command replaces it, and
  // `ll-search recover` restores the same key rather than issuing a new one.
  // The session-start notice said "Run /learning-loop:federation to rotate"
  // for a plugin major bump, sending a person to a skill with no such step.
  const hook = readFileSync(
    join(ROOT, 'plugin', 'hooks', 'session-start', 'vault-snapshot.mjs'),
    'utf8',
  );
  const notice = hook.slice(hook.indexOf('learning-loop federation:'));
  // The forbidden thing is the instruction, not the word: the replacement
  // line says "Nothing rotates an identity", which a bare /rotate/ would
  // fail. Pin the direction — "to rotate" — and the skill it used to send
  // people to for a step that skill does not have.
  const line = notice.split('\n')[0];
  assert.doesNotMatch(line, /\bto rotate\b/i, 'the notice must not tell anyone to rotate');
  assert.doesNotMatch(
    line,
    /learning-loop:federation/,
    'nor send them to a skill with no such step',
  );
  assert.match(
    flat(hook),
    /Run \\`ll-search status\\`/,
    'the actionable check for a pre-v5 config is `ll-search status`, which reports BLOCKED',
  );
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
