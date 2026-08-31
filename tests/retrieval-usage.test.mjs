import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'scripts');
const REPORT = join(SCRIPTS, 'retrieval-report.mjs');
const { sessionSurfaced, usageReport, loadNoteUsageEvents, loadUnevidencedInformed } = await import(
  pathToFileURL(join(SCRIPTS, 'lib', 'retrieval-usage.mjs')).href
);

const NOW = new Date('2026-06-12T00:00:00Z').getTime();
const daysAgo = (n) => new Date(NOW - n * 86_400_000).toISOString();

function makePluginData({ queries = [], dedupe = {}, provenance = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'll-usage-'));
  mkdirSync(join(root, 'retrieval', 'session-dedupe'), { recursive: true });
  mkdirSync(join(root, 'provenance'), { recursive: true });
  writeFileSync(
    join(root, 'retrieval', 'queries-2026-06.jsonl'),
    queries.map((q) => JSON.stringify(q)).join('\n'),
  );
  for (const [sid, entries] of Object.entries(dedupe)) {
    writeFileSync(
      join(root, 'retrieval', 'session-dedupe', `${sid}.json`),
      JSON.stringify(entries),
    );
  }
  writeFileSync(
    join(root, 'provenance', 'events-2026-06.jsonl'),
    provenance.map((e) => JSON.stringify(e)).join('\n'),
  );
  return root;
}

test('sessionSurfaced merges injected + retrieved for one session, keeps level', () => {
  const pd = makePluginData({
    queries: [
      {
        ts: daysAgo(0),
        session_id: 's1',
        command: 'query',
        top_paths: ['3-permanent/a.md', 'peer:remote/x.md', ''],
      },
      { ts: daysAgo(0), session_id: 's2', command: 'query', top_paths: ['3-permanent/other.md'] },
    ],
    dedupe: {
      s1: [
        { path: '3-permanent/a.md', level: 'pointer', ts: daysAgo(0) },
        { path: '0-inbox/b.md', level: 'body', ts: daysAgo(0) },
      ],
    },
  });
  try {
    const out = sessionSurfaced(pd, 's1');
    assert.deepStrictEqual(
      out.map((n) => n.path),
      ['0-inbox/b.md', '3-permanent/a.md'],
    );
    const a = out.find((n) => n.path === '3-permanent/a.md');
    assert.deepStrictEqual(a.via.sort(), ['injected', 'retrieved']);
    assert.strictEqual(a.level, 'pointer');
    assert.strictEqual(out.find((n) => n.path === '0-inbox/b.md').level, 'body');
  } finally {
    rmSync(pd, { recursive: true, force: true });
  }
});

test('usageReport: surfaced-never-used excludes used notes, counts explicit ignores', () => {
  const surfaceTimes = [daysAgo(1), daysAgo(2), daysAgo(3)];
  const pd = makePluginData({
    queries: surfaceTimes.flatMap((ts) => [
      { ts, session_id: 's1', top_paths: ['3-permanent/hot-never-used.md'] },
      { ts, session_id: 's1', top_paths: ['3-permanent/hot-used.md'] },
    ]),
    provenance: [
      {
        ts: daysAgo(1),
        session_id: 's1',
        action: 'note-usage',
        target: '3-permanent/hot-used.md',
        status: 'used',
        signals: ['read'],
      },
      {
        ts: daysAgo(1),
        session_id: 's1',
        action: 'note-usage',
        target: '3-permanent/hot-never-used.md',
        status: 'ignored',
        signals: [],
      },
      { ts: daysAgo(1), session_id: 's1', action: 'vault-write', target: '0-inbox/red-herring.md' },
    ],
  });
  try {
    const r = usageReport(pd, { now: NOW, minSurfaced: 3 });
    assert.deepStrictEqual(
      r.surfaced_never_used.map((n) => n.path),
      ['3-permanent/hot-never-used.md'],
    );
    assert.strictEqual(r.surfaced_never_used[0].surfaced, 3);
    assert.strictEqual(r.surfaced_never_used[0].ignored_events, 1);
    assert.strictEqual(r.used_events, 1);
    assert.strictEqual(r.ignored_events, 1);
    assert.strictEqual(r.evaluated_notes, 2);
  } finally {
    rmSync(pd, { recursive: true, force: true });
  }
});

test('usageReport: never_surfaced honors the window and flags limited log coverage', () => {
  const pd = makePluginData({
    queries: [
      { ts: daysAgo(5), session_id: 's1', top_paths: ['3-permanent/recent.md'] },
      // outside the 90d window: must NOT count as surfacing
      { ts: daysAgo(120), session_id: 's0', top_paths: ['3-permanent/ancient.md'] },
    ],
  });
  try {
    const r = usageReport(pd, {
      now: NOW,
      windowDays: 90,
      vaultNotes: ['3-permanent/recent.md', '3-permanent/ancient.md', '0-inbox/silent.md'],
    });
    assert.deepStrictEqual(r.never_surfaced, ['0-inbox/silent.md', '3-permanent/ancient.md']);
    // logs reach back 120d > window, so coverage is NOT limited
    assert.strictEqual(r.coverage_limited, false);
    assert.strictEqual(r.coverage_days, 90);

    const young = usageReport(pd, { now: NOW - 100 * 86_400_000, windowDays: 90 });
    assert.strictEqual(young.coverage_limited, true);
  } finally {
    rmSync(pd, { recursive: true, force: true });
  }
});

test('loadNoteUsageEvents folds unknown statuses to ignored (conservative)', () => {
  const pd = makePluginData({
    provenance: [
      {
        ts: daysAgo(1),
        action: 'note-usage',
        target: '0-inbox/a.md',
        status: 'maybe',
      },
    ],
  });
  try {
    const events = loadNoteUsageEvents(pd);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].status, 'ignored');
  } finally {
    rmSync(pd, { recursive: true, force: true });
  }
});

test('loadNoteUsageEvents reads the pre-rename `note` key as well as `target`', () => {
  // Earlier /reflect runs emitted the path as `note`; the field was renamed to
  // `target` and the readers were not. A record with neither key fails
  // isVaultNotePath and is skipped, so the rename dropped every pre-rename
  // event silently — 572 of them in one real vault, most of the usage history
  // the precision instrument had, with the report showing no sign of a gap.
  const pd = makePluginData({
    provenance: [
      { ts: daysAgo(1), action: 'note-usage', note: '0-inbox/old-shape.md', status: 'used' },
      { ts: daysAgo(1), action: 'note-usage', target: '0-inbox/new-shape.md', status: 'used' },
      // Neither key: still skipped, so a malformed record cannot sneak in.
      { ts: daysAgo(1), action: 'note-usage', status: 'used' },
      // `note` carrying a non-vault path is filtered the same as `target` would be.
      { ts: daysAgo(1), action: 'note-usage', note: 'peer:someone/x.md', status: 'used' },
    ],
  });
  try {
    const events = loadNoteUsageEvents(pd);
    assert.deepStrictEqual(
      events.map((e) => e.path).sort(),
      ['0-inbox/new-shape.md', '0-inbox/old-shape.md']
    );
    assert.ok(events.every((e) => e.status === 'used'));
  } finally {
    rmSync(pd, { recursive: true, force: true });
  }
});

test('loadUnevidencedInformed reads the pre-rename `note` key too', () => {
  // The second reader had the same bug; an unevidenced `informed` claim written
  // under the old key was invisible to the gap count that exists to surface it.
  const pd = makePluginData({
    provenance: [
      {
        ts: daysAgo(1),
        action: 'note-usage',
        note: '0-inbox/old-shape.md',
        status: 'used',
        signals: ['informed'],
      },
    ],
  });
  try {
    assert.deepStrictEqual(
      loadUnevidencedInformed(pd).map((e) => e.path),
      ['0-inbox/old-shape.md']
    );
  } finally {
    rmSync(pd, { recursive: true, force: true });
  }
});

test('CLI --session-surfaced prints JSON for the session', () => {
  const pd = makePluginData({
    dedupe: { sX: [{ path: '0-inbox/b.md', level: 'body', ts: daysAgo(0) }] },
  });
  try {
    const result = spawnSync('node', [REPORT, '--session-surfaced', 'sX'], {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: pd },
      encoding: 'utf-8',
    });
    assert.strictEqual(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.deepStrictEqual(parsed, [{ path: '0-inbox/b.md', via: ['injected'], level: 'body' }]);
  } finally {
    rmSync(pd, { recursive: true, force: true });
  }
});

test('CLI default report survives non-string query records and reaches the usage section', () => {
  const pd = makePluginData({
    queries: [{ ts: daysAgo(1), session_id: 's1', query: { bad: 'shape' }, top_paths: [] }],
  });
  writeFileSync(
    join(pd, 'retrieval', 'episodic-queries-2026-06.jsonl'),
    JSON.stringify({ ts: daysAgo(1), session_id: 's1', query: 42 }) + '\n',
  );
  try {
    const result = spawnSync('node', [REPORT], {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: pd, VAULT_PATH: join(pd, 'no-vault') },
      encoding: 'utf-8',
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /Note Usage/);
  } finally {
    rmSync(pd, { recursive: true, force: true });
  }
});

test('usageReport: reflect-scan queries do NOT create surfaced_never_used candidates', () => {
  // Finding 25: loadSurfacedEvents must exclude records with command:'reflect-scan'
  // so /reflect's own internal similarity scan does not manufacture surfaced+ignored telemetry.
  const pd = makePluginData({
    queries: [1, 2, 3].map((d) => ({
      ts: daysAgo(d),
      session_id: 's1',
      command: 'reflect-scan',
      top_paths: ['3-permanent/hub-note.md'],
    })),
  });
  try {
    const r = usageReport(pd, { now: NOW, minSurfaced: 1 });
    assert.deepStrictEqual(
      r.surfaced_never_used.map((n) => n.path),
      [],
      'reflect-scan records must not contribute to surfaced_never_used',
    );
    assert.strictEqual(r.surfaced_notes, 0, 'reflect-scan records must not count as surfaced');
  } finally {
    rmSync(pd, { recursive: true, force: true });
  }
});

test('usageReport: a used event outside the window does not shield the note from candidacy', () => {
  // Finding 28: loadNoteUsageEvents is windowed — an old used event (> 90d ago)
  // must not permanently shield a note that is surfaced and ignored today.
  const pd = makePluginData({
    queries: [1, 2, 3].map((d) => ({
      ts: daysAgo(d),
      session_id: 's1',
      top_paths: ['3-permanent/hot.md'],
    })),
    provenance: [
      {
        ts: daysAgo(200),
        session_id: 's0',
        action: 'note-usage',
        target: '3-permanent/hot.md',
        status: 'used',
        signals: ['read'],
      },
      {
        ts: daysAgo(1),
        session_id: 's1',
        action: 'note-usage',
        target: '3-permanent/hot.md',
        status: 'ignored',
        signals: [],
      },
    ],
  });
  try {
    const r = usageReport(pd, { now: NOW, windowDays: 90, minSurfaced: 3 });
    assert.deepStrictEqual(
      r.surfaced_never_used.map((n) => n.path),
      ['3-permanent/hot.md'],
      'a used event 200 days ago must not shield a note surfaced 3x in the current window',
    );
    assert.strictEqual(r.used_events, 0, 'out-of-window used event must not appear in counts');
  } finally {
    rmSync(pd, { recursive: true, force: true });
  }
});

test('CLI --usage --json emits the aggregation; text mode carries the honesty label', () => {
  const pd = makePluginData({
    queries: [1, 2, 3].map((d) => ({
      ts: daysAgo(d),
      session_id: 's1',
      top_paths: ['3-permanent/hot.md'],
    })),
    provenance: [
      {
        ts: daysAgo(1),
        session_id: 's1',
        action: 'note-usage',
        target: '3-permanent/hot.md',
        status: 'ignored',
        signals: [],
      },
    ],
  });
  const vault = join(pd, 'vault');
  mkdirSync(join(vault, '3-permanent'), { recursive: true });
  writeFileSync(join(vault, '3-permanent', 'hot.md'), '# hot');
  writeFileSync(join(vault, '3-permanent', 'cold.md'), '# cold');
  try {
    const env = { ...process.env, CLAUDE_PLUGIN_DATA: pd, VAULT_PATH: vault };
    const json = spawnSync('node', [REPORT, '--usage', '--json'], { env, encoding: 'utf-8' });
    assert.strictEqual(json.status, 0, json.stderr);
    const parsed = JSON.parse(json.stdout);
    assert.strictEqual(parsed.surfaced_never_used[0].path, '3-permanent/hot.md');
    assert.deepStrictEqual(parsed.never_surfaced, ['3-permanent/cold.md']);

    const text = spawnSync('node', [REPORT, '--usage'], { env, encoding: 'utf-8' });
    assert.strictEqual(text.status, 0, text.stderr);
    assert.match(text.stdout, /explicit 'ignored' event/);
    assert.match(text.stdout, /3x.*3-permanent\/hot\.md/);
  } finally {
    rmSync(pd, { recursive: true, force: true });
  }
});

test("usageReport: an 'informed' event with evidence counts as used, tracked apart from engagement", () => {
  const pd = makePluginData({
    queries: [1, 2, 3].map((d) => ({
      ts: daysAgo(d),
      session_id: 's1',
      top_paths: ['3-permanent/informed.md', '3-permanent/engaged.md'],
    })),
    provenance: [
      {
        ts: daysAgo(1),
        session_id: 's1',
        action: 'note-usage',
        target: '3-permanent/informed.md',
        status: 'used',
        signals: ['informed'],
        evidence: 'took "gate over-fires on 58%" into the JIT answer',
      },
      {
        ts: daysAgo(1),
        session_id: 's1',
        action: 'note-usage',
        target: '3-permanent/engaged.md',
        status: 'used',
        signals: ['read', 'linked'],
      },
    ],
  });
  try {
    const r = usageReport(pd, { now: NOW, minSurfaced: 3, minIgnored: 1 });
    assert.strictEqual(r.used_events, 2);
    assert.strictEqual(r.used_informed_events, 1);
    assert.strictEqual(r.used_engaged_events, 1);
    assert.deepStrictEqual(
      r.surfaced_never_used.map((n) => n.path),
      [],
      'a note the session was informed by is used, not an archive candidate',
    );
  } finally {
    rmSync(pd, { recursive: true, force: true });
  }
});

test("loadNoteUsageEvents: 'informed' without evidence is unauditable and counts neither way", () => {
  const pd = makePluginData({
    queries: [1, 2, 3].map((d) => ({
      ts: daysAgo(d),
      session_id: 's1',
      top_paths: ['3-permanent/bare.md'],
    })),
    provenance: [
      {
        ts: daysAgo(1),
        session_id: 's1',
        action: 'note-usage',
        target: '3-permanent/bare.md',
        status: 'used',
        signals: ['informed'],
      },
    ],
  });
  try {
    assert.deepStrictEqual(loadNoteUsageEvents(pd), []);
    const r = usageReport(pd, { now: NOW, minSurfaced: 3, minIgnored: 1 });
    assert.strictEqual(r.used_events, 0);
    assert.strictEqual(r.ignored_events, 0, 'an unevidenced claim is not evidence of non-use');
    assert.strictEqual(r.unevidenced_informed_events, 1);
    assert.deepStrictEqual(
      r.surfaced_never_used.map((n) => n.path),
      [],
      'dropping the claim must not promote the note to archive candidate',
    );
  } finally {
    rmSync(pd, { recursive: true, force: true });
  }
});

test('usageReport: candidacy needs an explicit ignore, not the absence of a used event', () => {
  const pd = makePluginData({
    queries: [1, 2, 3, 4, 5].map((d) => ({
      ts: daysAgo(d),
      session_id: 's1',
      top_paths: ['3-permanent/unevaluated.md'],
    })),
  });
  try {
    const r = usageReport(pd, { now: NOW, minSurfaced: 3, minIgnored: 1 });
    assert.deepStrictEqual(
      r.surfaced_never_used.map((n) => n.path),
      [],
      'no /reflect verdict ever ran on this note — silence is not evidence of non-use',
    );
    assert.deepStrictEqual(
      r.surfaced_unevaluated.map((n) => n.path),
      ['3-permanent/unevaluated.md'],
    );
    assert.strictEqual(r.surfaced_unevaluated[0].surfaced, 5);
  } finally {
    rmSync(pd, { recursive: true, force: true });
  }
});

test('usageReport: a used event with no signals stays used, counted as unspecified', () => {
  const pd = makePluginData({
    queries: [1, 2, 3].map((d) => ({
      ts: daysAgo(d),
      session_id: 's1',
      top_paths: ['3-permanent/legacy.md'],
    })),
    provenance: [
      {
        ts: daysAgo(1),
        session_id: 's1',
        action: 'note-usage',
        target: '3-permanent/legacy.md',
        status: 'used',
      },
    ],
  });
  try {
    const r = usageReport(pd, { now: NOW, minSurfaced: 3, minIgnored: 1 });
    assert.strictEqual(r.used_events, 1);
    assert.strictEqual(r.used_unspecified_events, 1);
    assert.strictEqual(r.used_engaged_events, 0);
    assert.strictEqual(r.used_informed_events, 0);
  } finally {
    rmSync(pd, { recursive: true, force: true });
  }
});
