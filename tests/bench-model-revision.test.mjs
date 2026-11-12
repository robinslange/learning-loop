import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readModelRevision } from '../bench/bench.mjs';

// The node CI jobs have no Rust toolchain, so the bench reads the pinned revision from
// provenance/models.json; ll-search's provenance test keeps that file equal to ll-core's pin.
test('the bench reads the bge-small revision without cargo', () => {
  assert.match(readModelRevision(), /^[0-9a-f]{40}$/);
});
