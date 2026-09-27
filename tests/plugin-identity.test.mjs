// tests/plugin-identity.test.mjs : the plugin's identity (name, marketplace,
// version) is spelled once and agrees everywhere it has to be copied.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderShim } from '../plugin/scripts/lib/shims.mjs';
import { SHIM_NAMES } from '../plugin/scripts/lib/paths.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

describe('shim text', () => {
  // Installed shims are rewritten whenever this text changes, so a refactor
  // that moves where the text comes from must not move a single byte.
  const snapshots = readJson('tests/fixtures/shim-snapshots.json');
  for (const platform of ['linux', 'win32']) {
    for (const name of SHIM_NAMES) {
      test(`${name} on ${platform} renders byte-identical to its snapshot`, () => {
        assert.equal(renderShim(name, platform), snapshots[`${name}.${platform}`]);
      });
    }
  }
});
