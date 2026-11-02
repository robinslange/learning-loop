// tests/vault-search-intentions.test.mjs
// Integration test: `vault-search.mjs intentions "<context>"` hands the context
// to ll-search and prints what it returns.

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

// A stub ll-search that records the argv it was handed and emits a JSON array.
// Without a discoverable binary, vault-search.mjs exits early (code 2).
//
// The stub MUST record argv. An earlier version echoed `[]` regardless of its
// arguments, which hid a flag being forwarded to the binary as the positional
// context argument: clap rejected it, intentions() swallowed the error and
// returned []. A stub that ignores argv cannot see that.
function createStubBinary(binDir, argvLog) {
  const stub = join(binDir, 'll-search');
  writeFileSync(
    stub,
    `#!/bin/sh\nprintf '%s\\n' "$@" >> ${argvLog}\necho '[{"path":"0-inbox/x.md","cue":"when x"}]'\n`,
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

function runIntentions(pluginData, vault, ...args) {
  return spawnSync(process.execPath, [VAULT_SEARCH, 'intentions', ...args], {
    encoding: 'utf8',
    timeout: 10000,
    env: {
      PATH: process.env.PATH,
      NODE_PATH: process.env.NODE_PATH || '',
      CLAUDE_PLUGIN_DATA: pluginData,
      VAULT_PATH: vault,
    },
  });
}

test(
  'vault-search intentions "<context>" passes the context to the binary and prints its rows',
  { timeout: 12000, skip: skipOnWindows('shebang stub: #!/bin/sh stubs not executable on win32') },
  () => {
    const tmpPluginData = mkdtempSync(join(tmpdir(), 'll-vsi-'));
    try {
      const binDir = join(tmpPluginData, 'bin');
      mkdirSync(binDir, { recursive: true });
      const argvLog = join(tmpPluginData, 'argv.log');
      createStubBinary(binDir, argvLog);
      const vault = vaultWithIndex(tmpPluginData);

      const result = runIntentions(tmpPluginData, vault, 'learning-loop');

      assert.ok(result.signal === null, `vault-search killed by signal ${result.signal}`);
      assert.deepEqual(JSON.parse(result.stdout), [{ path: '0-inbox/x.md', cue: 'when x' }]);

      const argv = readFileSync(argvLog, 'utf8').split('\n').filter(Boolean);
      assert.equal(argv[0], 'intentions');
      assert.equal(
        argv.length,
        3,
        `expected [intentions, <db>, <context>]; got ${JSON.stringify(argv)}`,
      );
      assert.equal(argv[2], 'learning-loop');
    } finally {
      rmSync(tmpPluginData, { recursive: true, force: true });
    }
  },
);

// A vault that has never been indexed has no intentions, and must not log an
// error each time it is asked.
test(
  'with no index, intentions prints an empty list and logs nothing',
  { timeout: 12000, skip: skipOnWindows('shebang stub: #!/bin/sh stubs not executable on win32') },
  () => {
    const tmpPluginData = mkdtempSync(join(tmpdir(), 'll-vsi-'));
    try {
      const binDir = join(tmpPluginData, 'bin');
      mkdirSync(binDir, { recursive: true });
      const argvLog = join(tmpPluginData, 'argv.log');
      createStubBinary(binDir, argvLog);
      const vault = join(tmpPluginData, 'vault');
      mkdirSync(vault);

      const result = runIntentions(tmpPluginData, vault, 'learning-loop');

      assert.deepEqual(JSON.parse(result.stdout), []);
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
