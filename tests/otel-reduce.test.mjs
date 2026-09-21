// tests/otel-reduce.test.mjs
// The shared reducer scaffolding: label value bounding, malformed-line
// accounting in readRecords, and the plausibility clamp on earliestTimestamp.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  labelOf,
  INVALID_LABEL,
  readRecords,
  earliestTimestamp,
  EARLIEST_PLAUSIBLE_MS,
  countBy,
} from '../plugin/scripts/otel/reduce.mjs';

function withFile(text, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'll-otel-reduce-'));
  try {
    const file = join(dir, 'events-2026-09.jsonl');
    writeFileSync(file, text);
    return fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// logError writes to stderr synchronously; capture it rather than reading a
// sink, so the assertion does not depend on CLAUDE_PLUGIN_DATA.
function captureStderr(fn) {
  const lines = [];
  const orig = process.stderr.write;
  process.stderr.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = orig;
  }
  return lines.join('');
}

test('labelOf passes an identifier through and replaces anything else', () => {
  assert.equal(labelOf('fm-verne-ui-typer'), 'fm-verne-ui-typer');
  assert.equal(labelOf(42), '42');
  assert.equal(labelOf('a sentence with spaces'), INVALID_LABEL);
  assert.equal(labelOf('/Users/robin/vault'), INVALID_LABEL);
  assert.equal(labelOf('x'.repeat(129)), INVALID_LABEL);
});

test('countBy never stamps a non-identifier value onto the wire', () => {
  const metrics = countBy([{ agent: 'refactor billing for acme corp' }, { agent: 'ok-agent' }], {
    name: 'provenance.agent',
    stream: 'provenance',
    by: ['agent'],
    timeUnixMs: 1,
    startTimeUnixMs: 1,
  });
  assert.deepEqual(metrics.map((m) => m.attributes.agent).sort(), [INVALID_LABEL, 'ok-agent']);
});

test('a truncated last line is skipped silently', () => {
  const text = '{"a":1}\n{"a":2}\n{"a":3,"b":';
  withFile(text, (file) => {
    let records;
    const err = captureStderr(() => {
      records = readRecords([file]);
    });
    assert.equal(records.length, 2);
    assert.doesNotMatch(err, /malformedLines/);
  });
});

test('a malformed line anywhere else, or a non-object line, is counted and logged once per file', () => {
  const text = '{"a":1}\nnot json\nnull\n"a string"\n{"a":2}\n';
  withFile(text, (file) => {
    let records;
    const err = captureStderr(() => {
      records = readRecords([file]);
    });
    assert.equal(records.length, 2);
    const logged = err
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((l) => l.scope === 'otel.reduce.malformedLines');
    assert.equal(logged.length, 1);
    assert.equal(logged[0].meta.malformed, 3);
  });
});

test('earliestTimestamp ignores an implausible timestamp instead of pinning the start to it', () => {
  const now = Date.parse('2026-09-22T00:00:00Z');
  const records = [
    { ts: '1970-01-01T00:00:00.000Z' },
    { ts: '2099-01-01T00:00:00.000Z' },
    { ts: 'garbage' },
    { ts: '2026-06-01T00:00:00.000Z' },
  ];
  assert.equal(earliestTimestamp(records, now), Date.parse('2026-06-01T00:00:00.000Z'));
  assert.equal(earliestTimestamp([{ ts: '1970-01-01T00:00:00.000Z' }], now), now);
  assert.ok(EARLIEST_PLAUSIBLE_MS > 0);
});
