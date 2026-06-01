// Contract test for the canonical PLUGIN_DATA path constants.
// Pins the shape so call sites can rely on stable names; renaming a folder
// here means changing one line that every caller follows.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DATA_PATHS, FEDERATION_PATHS, DATA_FILES } from '../scripts/lib/paths.mjs';

test('DATA_PATHS resolves PLUGIN_DATA subdirectories', () => {
  const pd = '/tmp/test-pd';
  assert.equal(DATA_PATHS.bin(pd), join(pd, 'bin'));
  assert.equal(DATA_PATHS.convergence(pd), join(pd, 'convergence'));
  assert.equal(DATA_PATHS.librarian(pd), join(pd, 'librarian'));
  assert.equal(DATA_PATHS.librarianQueue(pd), join(pd, 'librarian', 'queue.jsonl'));
  assert.equal(DATA_PATHS.retrieval(pd), join(pd, 'retrieval'));
  assert.equal(DATA_PATHS.retrievalSessionDedupe(pd), join(pd, 'retrieval', 'session-dedupe'));
  assert.equal(DATA_PATHS.provenance(pd), join(pd, 'provenance'));
  assert.equal(DATA_PATHS.federation(pd), join(pd, 'federation'));
  assert.equal(DATA_PATHS.sessionStartCache(pd), join(pd, 'session-start-cache'));
});

test('FEDERATION_PATHS resolves federation subtree', () => {
  const pd = '/tmp/test-pd';
  assert.equal(FEDERATION_PATHS.root(pd), join(pd, 'federation'));
  assert.equal(FEDERATION_PATHS.config(pd), join(pd, 'federation', 'config.json'));
  assert.equal(FEDERATION_PATHS.seedMeta(pd), join(pd, 'federation', '.seed-meta.json'));
  assert.equal(
    FEDERATION_PATHS.seedNoticeShown(pd),
    join(pd, 'federation', '.seed-notice-shown'),
  );
  assert.equal(FEDERATION_PATHS.outbox(pd), join(pd, 'federation', 'outbox'));
  assert.equal(FEDERATION_PATHS.peersDir(pd), join(pd, 'federation', 'data', 'peers'));
  assert.equal(
    FEDERATION_PATHS.peerDb(pd, 'abc123'),
    join(pd, 'federation', 'data', 'peers', 'abc123', 'index.db'),
  );
});

test('DATA_FILES resolves standalone data files', () => {
  const pd = '/tmp/test-pd';
  assert.equal(DATA_FILES.edgesDb(pd), join(pd, 'edges.db'));
  assert.equal(DATA_FILES.nliSocket(pd), join(pd, 'nli.sock'));
  assert.equal(DATA_FILES.binVersion(pd), join(pd, 'bin', '.version'));
});
