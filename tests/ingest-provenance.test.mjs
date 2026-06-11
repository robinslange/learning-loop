import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendIngestEvent } from '../plugin/scripts/ingest-provenance.mjs';

test('appends one JSONL line per call', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'prov-test-'));
  try {
    appendIngestEvent(dataDir, { slug: 'foo-abcdef', tier: 'parallel', duration_seconds: 100 });
    appendIngestEvent(dataDir, { slug: 'foo-abcdef', tier: 'single', duration_seconds: 5 });

    const lines = readFileSync(join(dataDir, 'ingest-provenance.jsonl'), 'utf-8').trim().split('\n');
    assert.equal(lines.length, 2);
    const e1 = JSON.parse(lines[0]);
    assert.equal(e1.slug, 'foo-abcdef');
    assert.equal(e1.tier, 'parallel');
    assert.equal(e1.skill, 'ingest');
    assert.equal(e1.source, 'repo');
    assert.ok(e1.ts);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('creates the data dir if absent', () => {
  const parent = mkdtempSync(join(tmpdir(), 'prov-mk-'));
  const dataDir = join(parent, 'nested', 'plugin-data');
  try {
    appendIngestEvent(dataDir, { slug: 'x', tier: 'single' });
    const lines = readFileSync(join(dataDir, 'ingest-provenance.jsonl'), 'utf-8').trim().split('\n');
    assert.equal(lines.length, 1);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
