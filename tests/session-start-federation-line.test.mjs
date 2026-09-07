// tests/session-start-federation-line.test.mjs
// The outage's real cost was that nobody looked. The cheapest place to be told
// is the line already printed at session start — so it has to say something
// when federation is broken, and nothing at all when it is not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { federationLine } from '../plugin/hooks/session-start/context-assembly.mjs';

const NOW = 1_757_000_000;

// Every case below pins WHICH answer came back, not that some answer mentioned
// the right word. `federationLine` has five branches and they overlap in
// vocabulary — "sync" is in four of them — so an assertion on a substring
// passes for any branch whose wording happens to overlap, and deleting the
// branch under test leaves the suite green.
const ok = (over) => ({
  outcome: 'ok',
  last_success_at: NOW - 3600,
  hub_holds: { kind: 'index', sha256: 'abc123', note_count: 3578 },
  ...over,
});

test('a healthy federation adds no noise', () => {
  assert.equal(federationLine(ok(), NOW), null);
});

test('a missing sync-state is a failure, not an unknown', () => {
  // `read_state` on the Rust side collapses a missing file and a corrupt one
  // into the same absence, so this is reached by both. Either way federation
  // is configured — the caller checked — and no cycle has ever finished.
  assert.equal(
    federationLine(null, NOW),
    'configured, but no sync cycle has ever completed. Run `ll-search status`.',
  );
});

test('an empty hub is reported, because that is what nothing said for two months', () => {
  assert.equal(
    federationLine(ok({ hub_holds: { kind: 'nothing' } }), NOW),
    'the hub holds no index for this vault. The next sync will re-upload it.',
  );
});

test('a failed cycle carries its detail', () => {
  const line = federationLine(
    { outcome: 'error', detail: 'hub key mismatch', last_success_at: null },
    NOW,
  );
  // `last_success_at: null` is set deliberately: the never-succeeded branch is
  // the one this would fall through to, and it must not be the one that
  // answers while the error branch is what has something to report.
  assert.equal(line, 'last sync failed — hub key mismatch');
});

test('a stale success says how stale, in days', () => {
  assert.equal(
    federationLine(ok({ last_success_at: NOW - 9 * 86400 }), NOW),
    'last successful sync was 9 days ago.',
  );
});

test('the staleness boundary is testable from both sides', () => {
  // Seven days exactly is not yet stale; a second past it is. A laptop shut
  // for a long weekend must stay quiet, and a months-old outage must not hide.
  assert.equal(federationLine(ok({ last_success_at: NOW - 7 * 86400 }), NOW), null);
  assert.equal(
    federationLine(ok({ last_success_at: NOW - 7 * 86400 - 1 }), NOW),
    'last successful sync was 7 days ago.',
  );
});

test('an ok cycle that never succeeded still says so', () => {
  // `last_success_at` is carried forward across failures, so null here means
  // no cycle has ever got all the way through. Reporting it as zero seconds
  // ago would be the silent-success bug in a new place.
  assert.equal(
    federationLine(ok({ last_success_at: null }), NOW),
    'no sync has ever succeeded on this vault.',
  );
});

test('a cycle that died before the handshake does not claim the hub is empty', () => {
  // `hub_holds: null` means the cycle never got far enough to ask. That is not
  // the same fact as the hub holding nothing, and must not render as one.
  const line = federationLine(ok({ hub_holds: null, last_success_at: NOW - 3600 }), NOW);
  assert.equal(line, null, 'a recent success with an unasked hub has nothing to add');
});
