import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reduceSession } from '../plugin/scripts/otel/reducers/session.mjs';
import { validateExportRecord, EXPORT_SCHEMA } from '../plugin/scripts/otel/schema.mjs';
import { buildOtlpPayload } from '../plugin/scripts/otel/otlp.mjs';
import { SUMMARY_ENUMS } from '../plugin/scripts/lib/session-ledger.mjs';

function withCorpus(events, fn) {
  const pluginData = mkdtempSync(join(tmpdir(), 'll-otel-session-'));
  try {
    const dir = join(pluginData, 'provenance');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'events-2026-09.jsonl'),
      events.map((e) => JSON.stringify(e)).join('\n'),
    );
    return fn(pluginData);
  } finally {
    rmSync(pluginData, { recursive: true, force: true });
  }
}
const summary = (over) => ({
  ts: '2026-09-21T00:00:00Z',
  source: 'hook',
  action: 'session-summary',
  session_id: 's1',
  prompts: 3,
  tool_uses: 10,
  tool_uses_direct: 8,
  files_edited: 2,
  commits: 1,
  skills_invoked: 0,
  agents_spawned: 1,
  transcript_bytes: 40000,
  duration_ms: 120000,
  latency_ms: 90,
  git_ms: 30,
  git_state: 'dirty',
  end_reason: 'open',
  project_source: 'derived',
  harness: 'claude-code',
  version: '2.1.0',
  final: false,
  ...over,
});

test('the session stream schema covers every summary field and nothing free-text', () => {
  const s = EXPORT_SCHEMA.session;
  for (const k of Object.keys(summary({}))) assert.ok(k in s, `${k} missing from schema`);
  for (const k of Object.keys(SUMMARY_ENUMS)) assert.equal(s[k], 'label');
  assert.equal(s.prompts, 'histogram');
  assert.equal(s.latency_ms, 'histogram');
});

test('one record per session: final wins, else the latest ts', () => {
  const events = [
    summary({ session_id: 's1', ts: '2026-09-21T00:00:00Z', prompts: 1 }),
    summary({ session_id: 's1', ts: '2026-09-21T00:10:00Z', prompts: 5 }),
    summary({
      session_id: 's2',
      ts: '2026-09-21T00:20:00Z',
      prompts: 7,
      final: true,
      end_reason: 'clear',
    }),
    summary({ session_id: 's2', ts: '2026-09-21T00:30:00Z', prompts: 9 }), // later but not final: loses
    { ts: '2026-09-21T00:40:00Z', action: 'vault-write', session_id: 's3', folder: 'inbox' }, // ignored
  ];
  withCorpus(events, (pluginData) => {
    const metrics = reduceSession({ pluginData, timeUnixMs: Date.now() });
    const count = metrics.filter((m) => m.name === 'll.session_count');
    assert.equal(
      count.reduce((a, m) => a + m.value, 0),
      2,
    );
    const prompts = metrics.find((m) => m.name === 'll.session_prompts');
    assert.equal(prompts.count, 2);
    assert.equal(prompts.sum, 5 + 7);
  });
});

test('counter attributes carry only the enum labels', () => {
  withCorpus([summary({})], (pluginData) => {
    const [c] = reduceSession({ pluginData, timeUnixMs: 1 }).filter(
      (m) => m.name === 'll.session_count',
    );
    assert.deepEqual(Object.keys(c.attributes).sort(), [
      'end_reason',
      'final',
      'git_state',
      'harness',
      'project_source',
    ]);
    assert.equal(c.attributes.final, 'false');
  });
});

test('every emitted metric validates and builds into an OTLP payload', () => {
  withCorpus(
    [summary({}), summary({ session_id: 's2', final: true, end_reason: 'other' })],
    (pluginData) => {
      const metrics = reduceSession({ pluginData, timeUnixMs: Date.now() });
      assert.ok(
        metrics.length >= 12,
        `expected a counter and eleven histograms, got ${metrics.length}`,
      );
      for (const m of metrics) validateExportRecord(m.stream, m.attributes || {});
      assert.doesNotThrow(() => buildOtlpPayload(metrics));
    },
  );
});

test('an empty corpus reduces to nothing', () => {
  withCorpus([], (pluginData) => {
    assert.deepEqual(reduceSession({ pluginData, timeUnixMs: 1 }), []);
  });
});
