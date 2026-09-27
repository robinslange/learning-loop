// The JS hooks and the native binary share one plugin-data directory, and each
// side spells the file names it reads on its own. This pins the contract
// between them: every name paths.mjs resolves for a file the Rust side also
// reads must appear as a string literal in the shipped Rust source (inline
// `#[cfg(test)] mod` blocks stripped), so a rename on either side goes red here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DATA_FILES, FEDERATION_PATHS } from '../plugin/scripts/lib/paths.mjs';

const CRATES = join(import.meta.dirname, '..', 'native', 'crates');

const rustSource = readdirSync(CRATES)
  .flatMap((crate) =>
    readdirSync(join(CRATES, crate, 'src'), { recursive: true })
      .filter((f) => f.endsWith('.rs'))
      .map((f) => join(CRATES, crate, 'src', f)),
  )
  .map((f) => readFileSync(f, 'utf8').split(/^#\[cfg\(test\)\]\s*\nmod /m)[0])
  .join('\n');

const pd = join('/', 'plugin-data');
const SHARED = {
  'FEDERATION_PATHS.config': FEDERATION_PATHS.config(pd),
  'FEDERATION_PATHS.seedMeta': FEDERATION_PATHS.seedMeta(pd),
  'FEDERATION_PATHS.peersDir': FEDERATION_PATHS.peersDir(pd),
  'FEDERATION_PATHS.peerDb': FEDERATION_PATHS.peerDb(pd, 'vault-id'),
  'FEDERATION_PATHS.syncState': FEDERATION_PATHS.syncState(pd),
  'FEDERATION_PATHS.readableVaults': FEDERATION_PATHS.readableVaults(pd),
  'FEDERATION_PATHS.vaultRegistry': FEDERATION_PATHS.vaultRegistry(pd),
  'DATA_FILES.dupScanSocket': DATA_FILES.dupScanSocket(pd),
};

for (const [helper, path] of Object.entries(SHARED)) {
  const name = basename(path);
  test(`${helper} names a file the Rust side also reads (${name})`, () => {
    assert.ok(
      rustSource.includes(`"${name}"`),
      `"${name}" from ${helper} does not appear in native/crates/*/src`,
    );
  });
}
