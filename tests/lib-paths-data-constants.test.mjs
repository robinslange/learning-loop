// Two contracts on the plugin-data directory.
//
// Every existing install already holds these paths on disk, so a rename that
// ships without a migration strands the user's data: a moved .harvest-denylist
// is a deny list nothing reads. The table below is that contract, and a new
// helper has to be added to it.
//
// The JS hooks and the native binary also each spell the file names they share
// on their own. Every such name must appear as a string literal in the Rust file
// that builds that path (inline `#[cfg(test)] mod` blocks stripped), so a file
// rename on either side goes red here. Only the file name is compared: the Rust
// directory components ("federation", "data") are too common to pin by search.
// Checking the owning file rather than all of native/crates matters, because
// "config.json" alone appears in four Rust files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { DATA_FILES, DATA_PATHS, FEDERATION_PATHS } from '../plugin/scripts/lib/paths.mjs';

const PERSISTED = {
  'DATA_FILES.edgesDb': 'edges.db',
  'DATA_FILES.dupScanSocket': 'nli.sock',
  'DATA_FILES.binVersion': 'bin/.version',
  'DATA_FILES.harvestDenylist': '.harvest-denylist',
  'DATA_FILES.harvestedLog': '.harvested-log',
  'DATA_PATHS.bin': 'bin',
  'DATA_PATHS.convergence': 'convergence',
  'DATA_PATHS.librarian': 'librarian',
  'DATA_PATHS.librarianQueue': 'librarian/queue.jsonl',
  'DATA_PATHS.logs': 'logs',
  'DATA_PATHS.retrieval': 'retrieval',
  'DATA_PATHS.retrievalSessionDedupe': 'retrieval/session-dedupe',
  'DATA_PATHS.reflectScratch': 'reflect-scratch',
  'DATA_PATHS.reflectPrefix': 'reflect-scratch/ll-ARG-reflect',
  'DATA_PATHS.session': 'session',
  'DATA_PATHS.markers': 'markers',
  'DATA_PATHS.provenance': 'provenance',
  'DATA_PATHS.federation': 'federation',
  'DATA_PATHS.sessionStartCache': 'session-start-cache',
  'DATA_PATHS.dreamEval': 'dream-eval',
  'DATA_PATHS.dreamEvalProbes': 'dream-eval/probes.jsonl',
  'DATA_PATHS.dreamEvalReports': 'dream-eval/reports',
  'FEDERATION_PATHS.root': 'federation',
  'FEDERATION_PATHS.config': 'federation/config.json',
  'FEDERATION_PATHS.seedMeta': 'federation/.seed-meta.json',
  'FEDERATION_PATHS.seedNoticeShown': 'federation/.seed-notice-shown',
  'FEDERATION_PATHS.outbox': 'federation/outbox',
  'FEDERATION_PATHS.peersDir': 'federation/data/peers',
  'FEDERATION_PATHS.peerDb': 'federation/data/peers/ARG/index.db',
  'FEDERATION_PATHS.syncState': 'federation/sync-state.json',
  'FEDERATION_PATHS.readableVaults': 'federation/readable-vaults.json',
  'FEDERATION_PATHS.vaultRegistry': 'vaults.json',
};

test('every plugin-data path an install already holds keeps its name', () => {
  const pd = join(sep, 'plugin-data');
  const actual = {};
  for (const [group, helpers] of Object.entries({ DATA_FILES, DATA_PATHS, FEDERATION_PATHS })) {
    for (const [name, fn] of Object.entries(helpers)) {
      actual[`${group}.${name}`] = relative(pd, fn(pd, 'ARG')).split(sep).join('/');
    }
  }
  assert.deepEqual(
    actual,
    PERSISTED,
    'a renamed path needs a migration for the data already on disk; a new one needs a row here',
  );
});

const SRC = join(import.meta.dirname, '..', 'native', 'crates', 'll-search', 'src');

function shippedRust(file) {
  return readFileSync(join(SRC, file), 'utf8').split(/^#\[cfg\(test\)\]\s*\nmod /m)[0];
}

const pd = join('/', 'plugin-data');
const SHARED = [
  ['FEDERATION_PATHS.config', FEDERATION_PATHS.config(pd), 'sync/config.rs'],
  ['FEDERATION_PATHS.seedMeta', FEDERATION_PATHS.seedMeta(pd), 'sync/config.rs'],
  ['FEDERATION_PATHS.peersDir', FEDERATION_PATHS.peersDir(pd), 'sync/config.rs'],
  ['FEDERATION_PATHS.peerDb', FEDERATION_PATHS.peerDb(pd, 'vault-id'), 'sync/config.rs'],
  ['FEDERATION_PATHS.syncState', FEDERATION_PATHS.syncState(pd), 'sync/config.rs'],
  ['FEDERATION_PATHS.readableVaults', FEDERATION_PATHS.readableVaults(pd), 'sync/config.rs'],
  ['FEDERATION_PATHS.vaultRegistry', FEDERATION_PATHS.vaultRegistry(pd), 'sync/registry.rs'],
  ['DATA_FILES.dupScanSocket', DATA_FILES.dupScanSocket(pd), 'sync/watch.rs'],
];

for (const [helper, path, rustFile] of SHARED) {
  const name = basename(path);
  test(`${helper} names the file ${rustFile} builds (${name})`, () => {
    assert.ok(
      shippedRust(rustFile).includes(`"${name}"`),
      `"${name}" from ${helper} does not appear in ${rustFile}`,
    );
  });
}
