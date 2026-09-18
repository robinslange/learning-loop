import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'scripts');
const { injectionPrecision } = await import(
  pathToFileURL(join(SCRIPTS, 'injection-precision.mjs')).href
);

const EPOCH = '2026-07-16T00:00:00.000Z';
const afterEpoch = '2026-07-18T00:00:00.000Z';
const beforeEpoch = '2026-07-10T00:00:00.000Z';

// One gate-pass-payload record = one injection burst.
const burst = (session_id, ts, paths) => ({
  type: 'gate-pass-payload',
  ts,
  session_id,
  payload: { injected_paths: paths },
});
const usage = (session_id, ts, target, status) => ({
  ts,
  session_id,
  action: 'note-usage',
  target,
  status,
});
const edit = (session_id, ts, target, action = 'vault-edit') => ({
  ts,
  session_id,
  action,
  target,
});

function makePluginData({ injections = [], provenance = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'll-injprec-'));
  mkdirSync(join(root, 'retrieval'), { recursive: true });
  mkdirSync(join(root, 'provenance'), { recursive: true });
  writeFileSync(
    join(root, 'retrieval', 'shadow-injection-2026-07.jsonl'),
    injections.map((r) => JSON.stringify(r)).join('\n'),
  );
  writeFileSync(
    join(root, 'provenance', 'events-2026-07.jsonl'),
    provenance.map((r) => JSON.stringify(r)).join('\n'),
  );
  return root;
}

test('a used injected note is a hit at its rank/level', () => {
  const pd = makePluginData({
    injections: [
      burst('s1', afterEpoch, [
        { path: '3-permanent/a.md', level: 'body' },
        { path: '3-permanent/b.md', level: 'pointer' },
      ]),
    ],
    provenance: [usage('s1', afterEpoch, '3-permanent/a.md', 'used')],
  });
  const r = injectionPrecision(pd, { epoch: EPOCH });
  assert.equal(r.overall.hit, 1);
  assert.equal(r.overall.total, 2);
  assert.equal(r.per_rank[0].precision, 1); // body used
  assert.equal(r.per_rank[1].precision, 0); // pointer ignored
  assert.equal(r.per_level.find((l) => l.level === 'body').hit, 1);
  assert.equal(r.per_level.find((l) => l.level === 'pointer').hit, 0);
});

test('re-injecting the same note across bursts counts once per (session,path,rank)', () => {
  const pd = makePluginData({
    injections: [
      burst('s1', afterEpoch, [{ path: '3-permanent/a.md', level: 'body' }]),
      burst('s1', afterEpoch, [{ path: '3-permanent/a.md', level: 'body' }]),
      burst('s1', afterEpoch, [{ path: '3-permanent/a.md', level: 'body' }]),
    ],
    provenance: [usage('s1', afterEpoch, '3-permanent/a.md', 'used')],
  });
  const r = injectionPrecision(pd, { epoch: EPOCH });
  // 3 bursts collapse to 1 distinct surfaced note; 1220-rows-from-56-notes bug.
  assert.equal(r.diagnostics.ranked_injection_bursts_rows, 3);
  assert.equal(r.diagnostics.joinable_distinct_surfaced, 1);
  assert.equal(r.overall.total, 1);
  assert.equal(r.overall.hit, 1);
});

test('same note at different ranks counts once per rank', () => {
  const pd = makePluginData({
    injections: [
      burst('s1', afterEpoch, [{ path: '3-permanent/a.md', level: 'body' }]),
      burst('s1', afterEpoch, [
        { path: '3-permanent/x.md', level: 'body' },
        { path: '3-permanent/a.md', level: 'pointer' },
      ]),
    ],
    provenance: [usage('s1', afterEpoch, '3-permanent/a.md', 'used')],
  });
  const r = injectionPrecision(pd, { epoch: EPOCH });
  // a.md at rank 0 and rank 1 = two distinct banners, both hits.
  assert.equal(r.per_rank[0].hit, 1); // a.md@0 + x.md@0? x.md not used
  assert.equal(r.per_rank[0].total, 2);
  assert.equal(r.per_rank[1].hit, 1); // a.md@1
  assert.equal(r.per_rank[1].total, 1);
});

test('a session with no usage provenance is unjoinable, not ignored', () => {
  const pd = makePluginData({
    injections: [burst('lonely', afterEpoch, [{ path: '3-permanent/a.md', level: 'body' }])],
    provenance: [], // no note-usage at all
  });
  const r = injectionPrecision(pd, { epoch: EPOCH });
  assert.equal(r.diagnostics.injection_sessions, 1);
  assert.equal(r.diagnostics.joinable_sessions, 0);
  assert.equal(r.overall.total, 0); // not counted as a miss
  assert.equal(r.overall.precision, null);
});

test('only literal status "used" is a hit; "ignored" is a miss', () => {
  const pd = makePluginData({
    injections: [
      burst('s1', afterEpoch, [
        { path: '3-permanent/a.md', level: 'body' },
        { path: '3-permanent/b.md', level: 'pointer' },
      ]),
    ],
    provenance: [
      usage('s1', afterEpoch, '3-permanent/a.md', 'ignored'),
      usage('s1', afterEpoch, '3-permanent/b.md', 'used'),
    ],
  });
  const r = injectionPrecision(pd, { epoch: EPOCH });
  // s1 is joinable (it has a 'used' event), both injected notes are scored.
  assert.equal(r.diagnostics.joinable_sessions, 1);
  assert.equal(r.overall.total, 2);
  assert.equal(r.overall.hit, 1); // only b.md
  assert.equal(r.per_rank[0].hit, 0); // a.md ignored
  assert.equal(r.per_rank[1].hit, 1); // b.md used
});

test('a vault-edit makes a session joinable and scores injected notes it edited', () => {
  const pd = makePluginData({
    injections: [
      burst('s1', afterEpoch, [
        { path: '3-permanent/a.md', level: 'body' },
        { path: '3-permanent/b.md', level: 'pointer' },
      ]),
    ],
    // No note-usage at all — this session never ran /reflect. It is joinable
    // only because it edited an injected note.
    provenance: [edit('s1', afterEpoch, '3-permanent/a.md')],
  });
  const r = injectionPrecision(pd, { epoch: EPOCH });
  assert.equal(r.diagnostics.usage_sessions, 1);
  assert.equal(r.diagnostics.joinable_sessions, 1);
  assert.equal(r.overall.hit, 1); // a.md edited
  assert.equal(r.per_rank[0].hit, 1);
  assert.equal(r.per_rank[1].hit, 0); // b.md untouched
});

test('vault-write counts as a used signal, same as vault-edit', () => {
  const pd = makePluginData({
    injections: [burst('s1', afterEpoch, [{ path: '3-permanent/a.md', level: 'body' }])],
    provenance: [edit('s1', afterEpoch, '3-permanent/a.md', 'vault-write')],
  });
  const r = injectionPrecision(pd, { epoch: EPOCH });
  assert.equal(r.overall.hit, 1);
});

test('bySource keeps note-usage and vault-edit contributions separate, no double-count', () => {
  const pd = makePluginData({
    injections: [burst('s1', afterEpoch, [{ path: '3-permanent/a.md', level: 'body' }])],
    provenance: [
      // Same (session, path) via BOTH channels — must count once as a used
      // pair, attributed to the source that first added it (note-usage).
      usage('s1', afterEpoch, '3-permanent/a.md', 'used'),
      edit('s1', afterEpoch, '3-permanent/a.md'),
      // A distinct edited note (not injected) — contributes to vault-edit count.
      edit('s1', afterEpoch, '3-permanent/z.md'),
    ],
  });
  const r = injectionPrecision(pd, { epoch: EPOCH });
  const src = r.diagnostics.used_pairs_by_source;
  assert.equal(src.note_usage, 1); // a.md
  assert.equal(src.vault_edit, 1); // z.md (a.md already claimed by note_usage)
  assert.equal(r.overall.hit, 1); // a.md injected+used, counted once
  assert.equal(r.overall.total, 1);
});

test('vault-edit events before the epoch are excluded', () => {
  const pd = makePluginData({
    injections: [burst('s1', afterEpoch, [{ path: '3-permanent/a.md', level: 'body' }])],
    provenance: [edit('s1', beforeEpoch, '3-permanent/a.md')],
  });
  const r = injectionPrecision(pd, { epoch: EPOCH });
  assert.equal(r.diagnostics.joinable_sessions, 0); // stale edit doesn't join
  assert.equal(r.overall.total, 0);
});

test('records before the epoch are excluded from both sides', () => {
  const pd = makePluginData({
    injections: [
      burst('s1', beforeEpoch, [{ path: '3-permanent/old.md', level: 'body' }]),
      burst('s1', afterEpoch, [{ path: '3-permanent/new.md', level: 'body' }]),
    ],
    provenance: [
      usage('s1', beforeEpoch, '3-permanent/old.md', 'used'),
      usage('s1', afterEpoch, '3-permanent/new.md', 'used'),
    ],
  });
  const r = injectionPrecision(pd, { epoch: EPOCH });
  assert.equal(r.diagnostics.ranked_injection_bursts_rows, 1); // only new.md burst
  assert.equal(r.overall.total, 1);
  assert.equal(r.overall.hit, 1);
});

test('hits are attributed by engagement, so precision resting on informed shows itself', () => {
  const informed = (session_id, ts, target) => ({
    ts,
    session_id,
    action: 'note-usage',
    target,
    status: 'used',
    signals: ['informed'],
    evidence: 'quoted its threshold claim in the answer',
  });
  const engaged = (session_id, ts, target) => ({
    ts,
    session_id,
    action: 'note-usage',
    target,
    status: 'used',
    signals: ['read'],
  });
  const pd = makePluginData({
    injections: [
      burst('s1', afterEpoch, [
        { path: '3-permanent/a.md', level: 'body' },
        { path: '3-permanent/b.md', level: 'pointer' },
      ]),
    ],
    provenance: [
      informed('s1', afterEpoch, '3-permanent/a.md'),
      engaged('s1', afterEpoch, '3-permanent/b.md'),
    ],
  });
  const r = injectionPrecision(pd, { epoch: EPOCH });
  assert.equal(r.overall.hit, 2, 'an informed note is a hit — the note reached the output');
  assert.equal(r.diagnostics.hits_by_engagement.informed, 1);
  assert.equal(r.diagnostics.hits_by_engagement.engaged, 1);
  assert.equal(r.diagnostics.used_pairs_by_source.note_usage_informed, 1);
  assert.equal(r.diagnostics.used_pairs_by_source.note_usage_engaged, 1);
});

test('the default window is the layout epoch, not the gate-calibration one', async () => {
  const { INJECTION_LAYOUT_EPOCH, INJECTION_CALIBRATION_EPOCH } = await import(
    pathToFileURL(join(SCRIPTS, 'lib', 'hook-config.mjs')).href
  );
  const r = injectionPrecision(makePluginData());
  assert.equal(r.epoch, INJECTION_LAYOUT_EPOCH);
  // Two epochs on purpose. This file reports which SLOT a note landed in, so a
  // layout change resets its denominators; the shadow-gate readiness check and
  // review-shadow count gate decisions, which v2.1.0 did not touch. One shared
  // constant would have thrown away six weeks of still-valid gate telemetry.
  assert.notEqual(INJECTION_LAYOUT_EPOCH, INJECTION_CALIBRATION_EPOCH);
});

test('a burst unreachable under the shipped layout is dropped, whatever its timestamp', () => {
  const pd = makePluginData({
    injections: [
      // Four pointers cannot happen under POINTER_SLOTS = 3, so pre-2.1.0 code
      // wrote this. That is not hypothetical: a session already running keeps
      // executing the inject hook it loaded, so old-shape bursts arrive after
      // the layout epoch (one was recorded 20 hours past it).
      burst('s1', afterEpoch, [
        { path: '3-permanent/old.md', level: 'body' },
        { path: '3-permanent/p1.md', level: 'pointer' },
        { path: '3-permanent/p2.md', level: 'pointer' },
        { path: '3-permanent/p3.md', level: 'pointer' },
        { path: '3-permanent/p4.md', level: 'pointer' },
      ]),
      burst('s1', afterEpoch, [{ path: '3-permanent/new.md', level: 'body' }]),
    ],
    provenance: [usage('s1', afterEpoch, '3-permanent/old.md', 'used')],
  });
  const r = injectionPrecision(pd, { epoch: EPOCH });
  assert.equal(r.diagnostics.foreign_layout_bursts_dropped, 1);
  // old.md was used, but the burst that surfaced it is denominated in the other
  // layout, so it must not contribute a hit to this window's numbers.
  assert.equal(r.diagnostics.ranked_injection_bursts_rows, 1);
  assert.equal(r.overall.total, 1);
  assert.equal(r.overall.hit, 0);
});

test('rank 1 is a body when the injector recorded one, not a pointer by arithmetic', () => {
  const pd = makePluginData({
    injections: [
      burst('s1', afterEpoch, [
        { path: '3-permanent/a.md', level: 'body' },
        { path: '3-permanent/b.md', level: 'body' },
        { path: '3-permanent/c.md', level: 'pointer' },
      ]),
    ],
    provenance: [usage('s1', afterEpoch, '3-permanent/b.md', 'used')],
  });
  const r = injectionPrecision(pd, { epoch: EPOCH });
  // The label was `rank === 0 ? 'body' : 'pointer'`, so this hit — a body — read
  // as a pointer in the one table used to compare the two formats. With the
  // window now holding only the 2-body layout, that was wrong for every row.
  assert.equal(r.per_rank[1].slot, 'body');
  assert.equal(r.per_rank[1].hit, 1);
  assert.equal(r.per_rank[2].slot, 'pointer');
  assert.equal(r.per_level.find((l) => l.level === 'body').total, 2);
});

test('a rank that carried both levels across the window reads as mixed', () => {
  const pd = makePluginData({
    injections: [
      burst('s1', afterEpoch, [
        { path: '3-permanent/a.md', level: 'body' },
        { path: '3-permanent/p.md', level: 'pointer' },
      ]),
      burst('s1', afterEpoch, [
        { path: '3-permanent/x.md', level: 'body' },
        { path: '3-permanent/y.md', level: 'body' },
      ]),
    ],
    provenance: [usage('s1', afterEpoch, '3-permanent/a.md', 'used')],
  });
  const r = injectionPrecision(pd, { epoch: EPOCH });
  assert.equal(r.per_rank[1].slot, 'mixed');
  assert.equal(r.per_rank[1].body, 1);
  assert.equal(r.per_rank[1].pointer, 1);
});

test('an unparseable epoch throws instead of windowing on NaN', () => {
  // Date.parse gives NaN, every `ts < NaN` is false, and the filter would admit
  // the entire history as though it were post-epoch — silently widening the
  // window rather than narrowing it, which is the failure worth being loud.
  const pd = makePluginData({
    injections: [burst('s1', beforeEpoch, [{ path: '3-permanent/a.md', level: 'body' }])],
    provenance: [usage('s1', beforeEpoch, '3-permanent/a.md', 'used')],
  });
  assert.throws(
    () => injectionPrecision(pd, { epoch: 'last Tuesday' }),
    /not a parseable timestamp/,
  );
});
