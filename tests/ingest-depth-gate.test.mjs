import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGatePrompt, parseGateResponse } from '../scripts/ingest-depth-gate.mjs';

test('prompt mentions the key thresholds', () => {
  const p = buildGatePrompt({ name: 'x', file_count: 50, languages: { ts: 50 }, frameworks_detected: ['next'] });
  assert.match(p, /file_count >= 200/);
  assert.match(p, /frameworks_detected count >= 3/);
  assert.match(p, /"tier": "single" \| "parallel"/);
});

test('prompt embeds the profile JSON', () => {
  const profile = { name: 'tinyrepo', file_count: 12 };
  const p = buildGatePrompt(profile);
  assert.match(p, /tinyrepo/);
  assert.match(p, /"file_count": 12/);
});

test('parseGateResponse extracts tier and reason', () => {
  const r = parseGateResponse('{"tier": "parallel", "reason": "monorepo with 4 langs"}');
  assert.equal(r.tier, 'parallel');
  assert.equal(r.reason, 'monorepo with 4 langs');
});

test('parseGateResponse handles surrounding text', () => {
  const r = parseGateResponse('Sure thing!\n```json\n{"tier": "single", "reason": "trivial"}\n```\n');
  assert.equal(r.tier, 'single');
  assert.equal(r.reason, 'trivial');
});

test('parseGateResponse defaults to single on bad JSON', () => {
  const r = parseGateResponse('not json');
  assert.equal(r.tier, 'single');
  assert.match(r.reason, /unparseable/);
});

test('parseGateResponse defaults to single on invalid tier value', () => {
  const r = parseGateResponse('{"tier": "deep", "reason": "x"}');
  assert.equal(r.tier, 'single');
  assert.match(r.reason, /invalid tier/);
});
