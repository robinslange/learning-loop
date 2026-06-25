// tests/vault-search-session-start-refresh.test.mjs
// Integration test: vault-search.mjs intentions --session-start-refresh
// writes the marker file to CLAUDE_PLUGIN_DATA/session-start-cache/intentions.json.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  existsSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { skipOnWindows } from './helpers/platform.mjs';

const VAULT_SEARCH = fileURLToPath(new URL('../plugin/scripts/vault-search.mjs', import.meta.url));

// Create a minimal stub ll-search binary that emits an empty JSON array and
// exits 0. Without a discoverable binary, vault-search.mjs exits early (code 2)
// before it reaches writeMarker. The stub satisfies hasBinary() and lets the
// intentions() call complete normally, returning [] and triggering the write.
function createStubBinary(binDir) {
  const stub = join(binDir, 'll-search');
  writeFileSync(stub, '#!/bin/sh\necho "[]"\n');
  chmodSync(stub, 0o755);
  return stub;
}

test(
  'vault-search intentions --session-start-refresh writes intentions.json marker',
  { timeout: 12000, skip: skipOnWindows('shebang stub: #!/bin/sh stubs not executable on win32') },
  () => {
    const tmpPluginData = mkdtempSync(join(tmpdir(), 'll-vssr-'));
    try {
      // Provide a stub binary so findBinary() succeeds and the script can reach
      // the writeMarker call instead of exiting early with code 2.
      const binDir = join(tmpPluginData, 'bin');
      mkdirSync(binDir, { recursive: true });
      createStubBinary(binDir);

      const result = spawnSync(
        process.execPath,
        [VAULT_SEARCH, 'intentions', '--session-start-refresh'],
        {
          encoding: 'utf8',
          timeout: 10000,
          env: {
            PATH: process.env.PATH,
            NODE_PATH: process.env.NODE_PATH || '',
            CLAUDE_PLUGIN_DATA: tmpPluginData,
          },
        },
      );

      assert.ok(result.signal === null, `vault-search killed by signal ${result.signal}`);

      const markerPath = join(tmpPluginData, 'session-start-cache', 'intentions.json');
      assert.ok(
        existsSync(markerPath),
        `marker file must exist at ${markerPath}\nstderr: ${result.stderr}`,
      );

      const raw = readFileSync(markerPath, 'utf8');
      let parsed;
      assert.doesNotThrow(() => {
        parsed = JSON.parse(raw);
      }, `marker file must be valid JSON; got: ${raw}`);
      assert.ok(Array.isArray(parsed), 'marker contents must be an array');
    } finally {
      rmSync(tmpPluginData, { recursive: true, force: true });
    }
  },
);
