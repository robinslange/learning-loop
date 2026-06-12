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
  const vocabulary = new Set([...gateMarkers(), '[partial]']);
  const sections = {
    'skills/verify/SKILL.md': '## Verification Markers',
    'skills/deepen/SKILL.md': '## Resolving Verification Markers',
  };
  for (const [rel, heading] of Object.entries(sections)) {
    const src = read(rel);
    const start = src.indexOf(heading);
    assert.notEqual(start, -1, `${rel} lost its "${heading}" section`);
    const rest = src.slice(start + heading.length);
    const end = rest.search(/\n## /);
    const section = rest.slice(0, end === -1 ? undefined : end);

    const delegates = section.includes('capture-rules.md');
    assert.ok(delegates, `${rel} must point its marker section at ${CANON} (restated lists drift)`);

    // Every marker the gate blocks on (plus advisory [partial]) must either be
    // named in the section or covered by the delegation to the canon.
    for (const marker of vocabulary) {
      assert.ok(
        delegates || section.includes(marker),
        `${rel} neither mentions ${marker} nor delegates to ${CANON}`,
      );
    }

    // Any marker the section DOES restate must exist in the gate's vocabulary —
    // a stale or invented marker here is exactly the drift the canon prevents.
    const restated = [...section.matchAll(/(?<!\[)\[([a-z][a-z ]*[a-z])\](?!\]|\()/g)].map(
      (m) => `[${m[1]}]`,
    );
    for (const marker of restated) {
      assert.ok(
        vocabulary.has(marker),
        `${rel} restates ${marker}, which is not in the gate's blocking set or [partial] — ${CANON} is canonical`,
      );
    }
  }
});
