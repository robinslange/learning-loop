// The JS hooks and the native binary share one plugin-data directory, and each
// side spells the file names it reads on its own. This pins the contract
// between them: every name paths.mjs resolves for a file the Rust side also
// reads must appear as a string literal in the Rust file that builds that path
// (inline `#[cfg(test)] mod` blocks stripped), so a rename on either side goes
// red here. Checking the owning file rather than all of native/crates matters:
// "config.json" alone appears in four Rust files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DATA_FILES, FEDERATION_PATHS } from '../plugin/scripts/lib/paths.mjs';

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
