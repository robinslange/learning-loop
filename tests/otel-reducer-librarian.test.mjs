// tests/otel-reducer-librarian.test.mjs
// See docs/plans/otel-consolidation.md, T1j "librarian queue metrics":
// queue.jsonl is already metric-shaped (bounded task/status/expired_reason
// enums), and the counts themselves are the argument for exporting it, e.g.
// 2,686 voice_flag suggestions with zero approvals ever. Whole-corpus
// re-derive per reduce.mjs's contract: no watermark, two runs must match.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reduceLibrarian } from '../plugin/scripts/otel/reducers/librarian.mjs';
import { validateExportRecord } from '../plugin/scripts/otel/schema.mjs';
import { buildOtlpPayload } from '../plugin/scripts/otel/otlp.mjs';

function record(overrides) {
  return {
    id: '2055cbc20574',
    task: 'voice_flag',
    target: '0-inbox/note.md',
    current_title: 'a title',
    reason: 'topic-style title (structured-output classifier)',
    status: 'expired',
    created_at: '2026-06-15T02:28:05.453Z',
    expired_reason: 'target_missing',
    ...overrides,
  };
}

function writeQueue(dir, records) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'queue.jsonl'),
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf-8',
  );
}

function makePluginData() {
  const pluginData = mkdtempSync(join(tmpdir(), 'll-otel-librarian-'));
  return { pluginData, librarianDir: join(pluginData, 'librarian') };
}

test('counts by task, status and expired_reason from a fixture', () => {
  const { pluginData, librarianDir } = makePluginData();
  try {
    writeQueue(librarianDir, [
      record({ task: 'voice_flag', status: 'expired', expired_reason: 'target_missing' }),
      record({ task: 'voice_flag', status: 'expired', expired_reason: 'target_missing' }),
      record({ task: 'tag_suggestion', status: 'approved', expired_reason: undefined }),
    ]);

    const metrics = reduceLibrarian({ pluginData, timeUnixMs: Date.now() });

    const byTask = metrics.filter((m) => m.name === 'll.librarian.queue_by_task');
    const voiceFlag = byTask.find((m) => m.attributes.task === 'voice_flag');
    assert.equal(voiceFlag.value, 2);
    const tagSuggestion = byTask.find((m) => m.attributes.task === 'tag_suggestion');
    assert.equal(tagSuggestion.value, 1);

    const byStatus = metrics.filter((m) => m.name === 'll.librarian.queue_by_status');
    assert.equal(byStatus.find((m) => m.attributes.status === 'expired').value, 2);
    assert.equal(byStatus.find((m) => m.attributes.status === 'approved').value, 1);

    const byExpiredReason = metrics.filter(
      (m) => m.name === 'll.librarian.queue_by_expired_reason',
    );
    assert.equal(byExpiredReason.length, 1);
    assert.equal(byExpiredReason[0].attributes.expired_reason, 'target_missing');
    assert.equal(byExpiredReason[0].value, 2);
  } finally {
    rmSync(pluginData, { recursive: true, force: true });
  }
});

test('the task x status cross-product counter produces the expected buckets', () => {
  const { pluginData, librarianDir } = makePluginData();
  try {
    writeQueue(librarianDir, [
      record({ task: 'voice_flag', status: 'expired' }),
      record({ task: 'voice_flag', status: 'expired' }),
      record({ task: 'voice_flag', status: 'pending' }),
      record({ task: 'tag_suggestion', status: 'approved' }),
    ]);

    const metrics = reduceLibrarian({ pluginData, timeUnixMs: Date.now() });
    const cross = metrics.filter((m) => m.name === 'll.librarian.queue_by_task_status');

    const voiceExpired = cross.find(
      (m) => m.attributes.task === 'voice_flag' && m.attributes.status === 'expired',
    );
    assert.equal(voiceExpired.value, 2);
    const voicePending = cross.find(
      (m) => m.attributes.task === 'voice_flag' && m.attributes.status === 'pending',
    );
    assert.equal(voicePending.value, 1);
    const tagApproved = cross.find(
      (m) => m.attributes.task === 'tag_suggestion' && m.attributes.status === 'approved',
    );
    assert.equal(tagApproved.value, 1);
    // The whole point of this cross-product: voice_flag never shows an approved bucket.
    assert.equal(
      cross.find((m) => m.attributes.task === 'voice_flag' && m.attributes.status === 'approved'),
      undefined,
    );
  } finally {
    rmSync(pluginData, { recursive: true, force: true });
  }
});

test('queue-depth gauge counts only pending', () => {
  const { pluginData, librarianDir } = makePluginData();
  try {
    writeQueue(librarianDir, [
      record({ status: 'pending' }),
      record({ status: 'pending' }),
      record({ status: 'expired' }),
      record({ status: 'approved' }),
    ]);

    const metrics = reduceLibrarian({ pluginData, timeUnixMs: Date.now() });
    const depth = metrics.find((m) => m.name === 'll.librarian.queue_depth');
    assert.equal(depth.type, 'gauge');
    assert.equal(depth.value, 2);
  } finally {
    rmSync(pluginData, { recursive: true, force: true });
  }
});

test('the lag histogram satisfies both bucket invariants', () => {
  const { pluginData, librarianDir } = makePluginData();
  try {
    const now = Date.now();
    writeQueue(librarianDir, [
      record({ status: 'pending', created_at: new Date(now - 3600_000).toISOString() }),
      record({ status: 'pending', created_at: new Date(now - 86400_000 * 5).toISOString() }),
      record({ status: 'expired', created_at: new Date(now - 86400_000 * 30).toISOString() }),
    ]);

    const metrics = reduceLibrarian({ pluginData, timeUnixMs: now });
    const lag = metrics.find((m) => m.name === 'll.librarian.pending_lag_ms');
    assert.ok(lag, 'expected a pending_lag_ms histogram');
    assert.equal(lag.bucketCounts.length, lag.explicitBounds.length + 1);
    assert.equal(
      lag.bucketCounts.reduce((a, b) => a + b, 0),
      lag.count,
    );
    // Only the two pending records feed the lag histogram, not the expired one.
    assert.equal(lag.count, 2);
  } finally {
    rmSync(pluginData, { recursive: true, force: true });
  }
});

test('score histograms skip records missing that score, no NaN, no zero-stuffing', () => {
  const { pluginData, librarianDir } = makePluginData();
  try {
    writeQueue(librarianDir, [
      record({ task: 'tag_suggestion', confidence: 0.9 }),
      record({ task: 'tag_suggestion' }), // no confidence
      record({ task: 'duplicate_flag', cosine_score: 0.4 }),
    ]);

    const metrics = reduceLibrarian({ pluginData, timeUnixMs: Date.now() });
    const confidenceHist = metrics.find((m) => m.name === 'll.librarian.confidence');
    assert.equal(confidenceHist.count, 1);
    assert.equal(confidenceHist.sum, 0.9);

    const cosineHist = metrics.find((m) => m.name === 'll.librarian.cosine_score');
    assert.equal(cosineHist.count, 1);

    // No score present at all for model_prob/similarity in this fixture.
    assert.equal(
      metrics.find((m) => m.name === 'll.librarian.model_prob'),
      undefined,
    );
    assert.equal(
      metrics.find((m) => m.name === 'll.librarian.similarity'),
      undefined,
    );
  } finally {
    rmSync(pluginData, { recursive: true, force: true });
  }
});

test('an absent queue file returns an empty array without throwing', () => {
  const pluginData = mkdtempSync(join(tmpdir(), 'll-otel-librarian-empty-'));
  try {
    assert.deepStrictEqual(reduceLibrarian({ pluginData, timeUnixMs: Date.now() }), []);
  } finally {
    rmSync(pluginData, { recursive: true, force: true });
  }
});

test('free-text fields never appear in any attribute set', () => {
  const { pluginData, librarianDir } = makePluginData();
  try {
    writeQueue(librarianDir, [
      record({
        target: '0-inbox/secret-path.md',
        reason: 'a long free text reason string',
        current_title: 'a sensitive title',
      }),
    ]);

    const metrics = reduceLibrarian({ pluginData, timeUnixMs: Date.now() });
    const forbidden = [
      'target',
      'reason',
      'current_title',
      'suggested_tags',
      'existing_tags',
      'duplicate_of',
      'suggested_link',
      'matched_patterns',
    ];
    for (const m of metrics) {
      if (!m.attributes) continue;
      for (const key of forbidden) {
        assert.ok(!(key in m.attributes), `${m.name} attributes leaked free-text field "${key}"`);
      }
    }
  } finally {
    rmSync(pluginData, { recursive: true, force: true });
  }
});

test('running the reducer twice returns identical output', () => {
  const { pluginData, librarianDir } = makePluginData();
  try {
    writeQueue(librarianDir, [
      record({ task: 'voice_flag', status: 'expired', expired_reason: 'target_missing' }),
      record({ task: 'tag_suggestion', status: 'approved', confidence: 0.7 }),
      record({
        task: 'link_suggestion',
        status: 'pending',
        created_at: '2026-09-10T00:00:00.000Z',
      }),
    ]);
    const timeUnixMs = Date.now();

    const first = reduceLibrarian({ pluginData, timeUnixMs });
    const second = reduceLibrarian({ pluginData, timeUnixMs });

    assert.deepStrictEqual(second, first);
  } finally {
    rmSync(pluginData, { recursive: true, force: true });
  }
});

test('every returned record validates against the librarian export schema', () => {
  const { pluginData, librarianDir } = makePluginData();
  try {
    writeQueue(librarianDir, [
      record({ task: 'voice_flag', status: 'expired', expired_reason: 'target_missing' }),
      record({ task: 'tag_suggestion', status: 'approved', confidence: 0.7, cosine_score: 0.5 }),
      record({
        task: 'link_suggestion',
        status: 'pending',
        created_at: '2026-09-10T00:00:00.000Z',
      }),
    ]);

    const metrics = reduceLibrarian({ pluginData, timeUnixMs: Date.now() });
    assert.ok(metrics.length > 0);
    for (const m of metrics) {
      assert.equal(m.stream, 'librarian');
      assert.doesNotThrow(() => validateExportRecord(m.stream, m.attributes || {}));
    }
  } finally {
    rmSync(pluginData, { recursive: true, force: true });
  }
});

test('output serializes through buildOtlpPayload without throwing', () => {
  const { pluginData, librarianDir } = makePluginData();
  try {
    writeQueue(librarianDir, [
      record({ task: 'voice_flag', status: 'expired', expired_reason: 'target_missing' }),
      record({ task: 'tag_suggestion', status: 'approved', confidence: 0.7 }),
    ]);

    const metrics = reduceLibrarian({ pluginData, timeUnixMs: Date.now() });
    assert.doesNotThrow(() => buildOtlpPayload(metrics));
  } finally {
    rmSync(pluginData, { recursive: true, force: true });
  }
});
