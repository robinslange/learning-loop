import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', 'plugin');

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

// The gate's MARKERS array is module-private; parse it from source so the
// test tracks the real blocking set, not a copy.
function gateMarkers() {
  const src = read('scripts/promotion-gate.mjs');
  const block = src.match(/const MARKERS = \[([\s\S]*?)\];/);
  assert.ok(block, 'promotion-gate.mjs lost its MARKERS array');
  const markers = [...block[1].matchAll(/'(\[[^']+\])'/g)].map((m) => m[1]);
  assert.ok(markers.length >= 4, `parsed only ${markers.length} markers`);
  return markers;
}

const CANON = 'agents/_skills/capture-rules.md';

test('capture-rules.md documents every promotion-blocking marker (canonical vocabulary)', () => {
  const canon = read(CANON);
  for (const marker of gateMarkers()) {
    assert.ok(
      canon.includes(marker),
      `${CANON} is the canonical marker vocabulary but is missing ${marker} (blocking set in scripts/promotion-gate.mjs)`,
    );
  }
});

test('capture-rules.md documents the advisory [partial] marker', () => {
  assert.ok(
    read(CANON).includes('[partial]'),
    `${CANON} must document [partial] (emitted by note-verifier, carried by /quick and /discovery)`,
  );
});

test('marker-consuming skills reference the canonical vocabulary instead of restating it', () => {
  for (const rel of ['skills/verify/SKILL.md', 'skills/deepen/SKILL.md']) {
    const src = read(rel);
    assert.ok(
      src.includes('capture-rules.md'),
      `${rel} must point its marker section at ${CANON} (restated lists drift)`,
    );
    assert.ok(
      src.includes('[not in source]') && src.includes('[partial]'),
      `${rel} marker section must acknowledge [not in source] and [partial]`,
    );
  }
});
