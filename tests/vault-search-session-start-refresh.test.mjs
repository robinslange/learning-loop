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
  readdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { skipOnWindows } from './helpers/platform.mjs';
import { VAULT_PATHS } from '../plugin/scripts/lib/paths.mjs';

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
  writeFileSync(
    stub,
    `#!/bin/sh\nprintf '%s\\n' "$@" >> ${argvLog}\necho '[{"context":"x","count":1}]'\n`,
  );
  chmodSync(stub, 0o755);
  return stub;
}

// A vault whose index exists, so intentions has something to ask the binary.
function vaultWithIndex(root) {
  const vault = join(root, 'vault');
  mkdirSync(VAULT_PATHS.dir(vault), { recursive: true });
  writeFileSync(VAULT_PATHS.index(vault), '');
  return vault;
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
      const vault = vaultWithIndex(tmpPluginData);

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
            VAULT_PATH: vault,
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

// session-start runs this refresh in the background every session. A vault
// that has never been indexed has no intentions, and must not log an error
// each time it asks.
test(
  'with no index, the refresh writes an empty marker and logs nothing',
  { timeout: 12000, skip: skipOnWindows('shebang stub: #!/bin/sh stubs not executable on win32') },
  () => {
    const tmpPluginData = mkdtempSync(join(tmpdir(), 'll-vssr-'));
    try {
      const binDir = join(tmpPluginData, 'bin');
      mkdirSync(binDir, { recursive: true });
      const argvLog = join(tmpPluginData, 'argv.log');
      createStubBinary(binDir, argvLog);
      const vault = join(tmpPluginData, 'vault');
      mkdirSync(vault);

      spawnSync(process.execPath, [VAULT_SEARCH, 'intentions', '--session-start-refresh'], {
        encoding: 'utf8',
        timeout: 10000,
        env: {
          PATH: process.env.PATH,
          NODE_PATH: process.env.NODE_PATH || '',
          CLAUDE_PLUGIN_DATA: tmpPluginData,
          VAULT_PATH: vault,
        },
      });

      const markerPath = join(tmpPluginData, 'session-start-cache', 'intentions.json');
      assert.deepEqual(JSON.parse(readFileSync(markerPath, 'utf8')), []);
      assert.ok(
        !existsSync(argvLog),
        'the binary must not be asked about an index that does not exist',
      );
      const logs = join(tmpPluginData, 'logs');
      const errors = existsSync(logs)
        ? readdirSync(logs)
            .flatMap((f) => readFileSync(join(logs, f), 'utf8').trim().split('\n'))
            .filter(Boolean)
            .map((l) => JSON.parse(l))
            .filter((row) => row.level === 'error')
        : [];
      assert.deepEqual(errors, []);
    } finally {
      rmSync(tmpPluginData, { recursive: true, force: true });
    }
  },
);
