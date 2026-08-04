// tests/vault-search-arg-parsing.test.mjs — the query must survive flag order.
//
// stripFlags took one list of "flags" and dropped both the flag AND the token
// after it. `--rerank` is a boolean, but it sat in that list alongside the
// value-taking `--top`/`--candidates`/`--threshold`, so
// `vault-search.mjs query --rerank "caffeine tolerance"` dropped the query text
// and searched for the empty string — no error, no results, and guide/search.md
// documents `--rerank` as an accepted flag on that command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { skipOnWindows } from './helpers/platform.mjs';

const VAULT_SEARCH = fileURLToPath(new URL('../plugin/scripts/vault-search.mjs', import.meta.url));

// A stub ll-search that records the argv it was handed and returns an empty
// result set, so the test can assert what the query text resolved to.
function withStub(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'll-vs-args-'));
  try {
    const binDir = join(dir, 'bin');
    mkdirSync(binDir, { recursive: true });
    const argvLog = join(dir, 'argv.log');
    const stub = join(binDir, 'll-search');
    writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${argvLog}\necho '{"results":[]}'\n`);
    chmodSync(stub, 0o755);
    return fn({ dir, argvLog });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function queryTextFor(args) {
  return withStub(({ dir, argvLog }) => {
    execFileSync(process.execPath, [VAULT_SEARCH, ...args], {
      encoding: 'utf8',
      timeout: 10000,
      env: { PATH: process.env.PATH, CLAUDE_PLUGIN_DATA: dir },
    });
    const argv = readFileSync(argvLog, 'utf8').split('\n').filter(Boolean);
    // ll-search is invoked as `query <db> <text> --top N ...` (or `rerank ...`).
    return argv[2];
  });
}

const opts = {
  timeout: 20000,
  skip: skipOnWindows('shebang stub: #!/bin/sh stubs not executable on win32'),
};

test('the query survives --rerank appearing before it', opts, () => {
  assert.equal(queryTextFor(['query', '--rerank', 'caffeine tolerance']), 'caffeine tolerance');
});

test('the query survives --rerank appearing after it', opts, () => {
  assert.equal(queryTextFor(['query', 'caffeine tolerance', '--rerank']), 'caffeine tolerance');
});

test('a value flag still consumes exactly its own value', opts, () => {
  assert.equal(queryTextFor(['query', '--top', '5', 'caffeine tolerance']), 'caffeine tolerance');
  assert.equal(queryTextFor(['query', 'caffeine tolerance', '--top', '5']), 'caffeine tolerance');
});

test('boolean and value flags interleaved still leave the query intact', opts, () => {
  assert.equal(
    queryTextFor(['query', '--rerank', '--top', '5', 'caffeine tolerance']),
    'caffeine tolerance',
  );
});

test('search takes the same treatment as query', opts, () => {
  assert.equal(queryTextFor(['search', '--rerank', 'caffeine tolerance']), 'caffeine tolerance');
});
