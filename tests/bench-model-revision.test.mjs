import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readModelRevision } from '../bench/bench.mjs';

// ll-core comes from crates.io, so the bench must find its bge_small.rs where cargo resolved it,
// and its pinned revision must be the one provenance/models.json records.
test('the bench reads the bge-small revision from the resolved ll-core', () => {
  const models = JSON.parse(readFileSync(new URL('../provenance/models.json', import.meta.url), 'utf8'));
  const bge = models.models.find(m => m.id === 'bge-small-en-v1.5');
  assert.equal(readModelRevision(), bge.revision);
});
