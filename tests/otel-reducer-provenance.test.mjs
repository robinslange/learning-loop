// tests/otel-reducer-provenance.test.mjs
// T2b: the provenance reducer. Reads the whole provenance corpus, recomputes
// counts by action/agent/skill/folder from scratch, returns metric records in
// otlp.mjs's input shape. See docs/plans/otel-consolidation.md, "Phase 2:
// aggregators and POST", signal mapping.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reduceProvenance } from '../plugin/scripts/otel/reducers/provenance.mjs';
import { validateExportRecord } from '../plugin/scripts/otel/schema.mjs';
import { buildOtlpPayload } from '../plugin/scripts/otel/otlp.mjs';

function withCorpus(events, fn) {
  const pluginData = mkdtempSync(join(tmpdir(), 'll-otel-provenance-'));
  try {
    const dir = join(pluginData, 'provenance');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'events-2026-05.jsonl'), events.map((e) => JSON.stringify(e)).join('\n'));
    return fn(pluginData);
  } finally {
    rmSync(pluginData, { recursive: true, force: true });
  }
}

function countersNamed(metrics, name) {
  return metrics.filter((m) => m.name === `ll.provenance_${name}`);
}

test('a fixture corpus produces the expected counts per action', () => {
  const events = [
    { ts: '2026-05-01T00:00:00Z', action: 'vault-write', session_id: 's1', folder: 'permanent' },
    { ts: '2026-05-01T00:00:01Z', action: 'vault-write', session_id: 's1', folder: 'inbox' },
    { ts: '2026-05-01T00:00:02Z', action: 'verify', session_id: 's2', agent: 'verify' },
  ];

  withCorpus(events, (pluginData) => {
    const metrics = reduceProvenance({ pluginData, timeUnixMs: Date.now() });
    const actionCounters = countersNamed(metrics, 'actions');
    const vaultWrite = actionCounters.find((m) => m.attributes.action === 'vault-write');
    const verify = actionCounters.find((m) => m.attributes.action === 'verify');
    assert.strictEqual(vaultWrite.value, 2);
    assert.strictEqual(verify.value, 1);
  });
});

test('running the reducer twice returns identical output', () => {
  const events = [
    { ts: '2026-05-01T00:00:00Z', action: 'vault-write', session_id: 's1', folder: 'permanent', agent: 'note-writer' },
    { ts: '2026-05-01T00:00:01Z', action: 'agent-result', session_id: 's1', agent: 'note-scorer' },
  ];

  withCorpus(events, (pluginData) => {
    const timeUnixMs = 1234567890;
    const first = reduceProvenance({ pluginData, timeUnixMs });
    const second = reduceProvenance({ pluginData, timeUnixMs });
    assert.deepStrictEqual(first, second);
  });
});

test('an absent provenance directory returns [] without throwing', () => {
  const pluginData = mkdtempSync(join(tmpdir(), 'll-otel-provenance-missing-'));
  try {
    assert.doesNotThrow(() => {
      const metrics = reduceProvenance({ pluginData, timeUnixMs: Date.now() });
      assert.deepStrictEqual(metrics, []);
    });
  } finally {
    rmSync(pluginData, { recursive: true, force: true });
  }
});

test('a record with an unknown or garbage action does not produce a metric label', () => {
  const events = [
    { ts: '2026-05-01T00:00:00Z', action: 'totally-made-up', session_id: 's1' },
    { ts: '2026-05-01T00:00:01Z', action: 'verify', session_id: 's1' },
  ];

  withCorpus(events, (pluginData) => {
    const metrics = reduceProvenance({ pluginData, timeUnixMs: Date.now() });
    const actionCounters = countersNamed(metrics, 'actions');
    const labels = actionCounters.map((m) => m.attributes.action);
    assert.ok(!labels.includes('totally-made-up'));
    assert.ok(labels.includes('verify'));
  });
});

test('a legacy action still counts', () => {
  const events = [{ ts: '2026-05-01T00:00:00Z', action: 'write', session_id: 's1' }];

  withCorpus(events, (pluginData) => {
    const metrics = reduceProvenance({ pluginData, timeUnixMs: Date.now() });
    const actionCounters = countersNamed(metrics, 'actions');
    const legacy = actionCounters.find((m) => m.attributes.action === 'write');
    assert.ok(legacy, 'expected a counter for the legacy "write" action');
    assert.strictEqual(legacy.value, 1);
  });
});

test('every returned record passes phase 0 attribute validation', () => {
  const events = [
    { ts: '2026-05-01T00:00:00Z', action: 'vault-write', session_id: 's1', folder: 'permanent', agent: 'note-writer', skill: 'reflect' },
    { ts: '2026-05-01T00:00:01Z', action: 'agent-result', session_id: 's1', agent: 'note-scorer' },
  ];

  withCorpus(events, (pluginData) => {
    const metrics = reduceProvenance({ pluginData, timeUnixMs: Date.now() });
    assert.ok(metrics.length > 0);
    for (const m of metrics) {
      assert.strictEqual(m.stream, 'provenance');
      assert.doesNotThrow(() => validateExportRecord(m.stream, m.attributes || {}));
    }
  });
});

test('the output serializes through buildOtlpPayload without throwing', () => {
  const events = [
    { ts: '2026-05-01T00:00:00Z', action: 'vault-write', session_id: 's1', folder: 'permanent', agent: 'note-writer', skill: 'reflect' },
    { ts: '2026-05-01T00:00:01Z', action: 'agent-result', session_id: 's1', agent: 'note-scorer' },
  ];

  withCorpus(events, (pluginData) => {
    const metrics = reduceProvenance({ pluginData, timeUnixMs: Date.now() });
    assert.doesNotThrow(() => buildOtlpPayload(metrics));
  });
});

test('counts by skill only where present', () => {
  const events = [
    { ts: '2026-05-01T00:00:00Z', action: 'vault-write', session_id: 's1', skill: 'reflect' },
    { ts: '2026-05-01T00:00:01Z', action: 'agent-result', session_id: 's1', agent: 'note-scorer' },
  ];

  withCorpus(events, (pluginData) => {
    const metrics = reduceProvenance({ pluginData, timeUnixMs: Date.now() });
    const skillCounters = countersNamed(metrics, 'skill');
    assert.strictEqual(skillCounters.length, 1);
    assert.strictEqual(skillCounters[0].attributes.skill, 'reflect');
  });
});
