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

// Create a minimal stub ll-search binary that records the argv it was handed
// and emits a JSON array. Without a discoverable binary, vault-search.mjs exits
// early (code 2) before it reaches writeMarker.
//
// The stub MUST record argv. An earlier version echoed `[]` regardless of its
// arguments, which made the marker assertion pass while `--session-start-refresh`
// was being forwarded to the binary as the positional context argument — clap
// rejected it, intentions() swallowed the error and returned [], and the marker
// was empty on every real run. A stub that ignores argv cannot see that.
function createStubBinary(binDir, argvLog) {
  const stub = join(binDir, 'll-search');
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${argvLog}\necho '[{"context":"x","count":1}]'\n`);
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
      const argvLog = join(tmpPluginData, 'argv.log');
      createStubBinary(binDir, argvLog);

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

      // The hook's own flag must never reach the binary, and the refreshed
      // marker must carry the rows the binary returned rather than the empty
      // array a swallowed CLI error produces.
      const argv = readFileSync(argvLog, 'utf8').split('\n').filter(Boolean);
      assert.deepEqual(
        argv.filter((a) => a.startsWith('--')),
        [],
        `ll-search was handed a flag it does not accept: ${JSON.stringify(argv)}`,
      );
      assert.equal(argv[0], 'intentions');
      assert.equal(argv.length, 2, `expected [intentions, <db>]; got ${JSON.stringify(argv)}`);
      assert.deepEqual(parsed, [{ context: 'x', count: 1 }]);
    } finally {
      rmSync(tmpPluginData, { recursive: true, force: true });
    }
  },
);
