// tests/session-start-federation-line.test.mjs
// The outage's real cost was that nobody looked. The cheapest place to be told
// is the line already printed at session start — so it has to say something
// when federation is broken, and nothing at all when it is not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { federationLine } from '../plugin/hooks/session-start/context-assembly.mjs';

const NOW = 1_757_000_000;
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
  assert.match(federationLine(null, NOW), /never completed|no sync cycle has ever completed/i);
});

test('an empty hub is reported, because that is what nothing said for two months', () => {
  assert.match(federationLine(ok({ hub_holds: { kind: 'nothing' } }), NOW), /hub holds no index/i);
});

test('a failed cycle carries its detail', () => {
  const line = federationLine(
    { outcome: 'error', detail: 'hub key mismatch', last_success_at: null },
    NOW,
  );
  assert.match(line, /hub key mismatch/);
});

test('a stale success says how stale, in days', () => {
  assert.match(federationLine(ok({ last_success_at: NOW - 9 * 86400 }), NOW), /9 days/);
});

test('the staleness boundary is testable from both sides', () => {
  // Seven days exactly is not yet stale; a second past it is. A laptop shut
  // for a long weekend must stay quiet, and a months-old outage must not hide.
  assert.equal(federationLine(ok({ last_success_at: NOW - 7 * 86400 }), NOW), null);
  assert.match(federationLine(ok({ last_success_at: NOW - 7 * 86400 - 1 }), NOW), /7 days ago/);
});

test('an ok cycle that never succeeded still says so', () => {
  // `last_success_at` is carried forward across failures, so null here means
  // no cycle has ever got all the way through. Reporting it as zero seconds
  // ago would be the silent-success bug in a new place.
  assert.match(federationLine(ok({ last_success_at: null }), NOW), /has ever succeeded/i);
});

test('a cycle that died before the handshake does not claim the hub is empty', () => {
  // `hub_holds: null` means the cycle never got far enough to ask. That is not
  // the same fact as the hub holding nothing, and must not render as one.
  const line = federationLine(ok({ hub_holds: null, last_success_at: NOW - 3600 }), NOW);
  assert.equal(line, null, 'a recent success with an unasked hub has nothing to add');
});
