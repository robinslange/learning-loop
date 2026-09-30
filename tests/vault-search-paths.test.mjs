// tests/vault-search-paths.test.mjs
//
// Everything the search stack keeps beside a vault lives under
// `<vault>/.vault-search/`. That path used to be spelled by hand at thirteen
// call sites across nine files, and the copies had already drifted: the index
// alone appeared as `join(v, '.vault-search', 'vault-index.db')`, as
// `join(v, '.vault-search/vault-index.db')`, and as `resolve(...)` of the
// latter. `VAULT_PATHS` is now the only speller.
//
// The guard on top of it had drifted further. `watch-daemon.mjs` refused to run
// without both a binary and an index; `pre-write-check.js` checked the index
// alone; and `vault-search.mjs`'s `intentions()` checked neither, so a vault
// nobody had indexed yet reached the binary, failed on the missing file, and
// was logged as an error on every session start before the first index.
//
// CI could not see that last one. CI installs no `ll-search` binary, so the
// hook never shells out and the error never happens there — a gate that passed
// because it could not run. The first test below therefore asserts on
// `intentions()`'s own behaviour with no binary in play, which is a thing CI
// does exercise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { VAULT_PATHS, hasVaultIndex } from '../plugin/scripts/lib/paths.mjs';
import { gitEnv } from '../plugin/scripts/lib/session-ledger.mjs';

const ROOT = join(import.meta.dirname, '..');

test('VAULT_PATHS puts all three artifacts under one directory', () => {
  const v = join('/tmp', 'vault');
  assert.equal(VAULT_PATHS.dir(v), join(v, '.vault-search'));
  assert.equal(VAULT_PATHS.index(v), join(v, '.vault-search', 'vault-index.db'));
  assert.equal(VAULT_PATHS.watchPid(v), join(v, '.vault-search', 'watch.pid'));
  // The index and the pidfile are siblings in the directory, not independently
  // spelled paths that merely happen to agree.
  assert.equal(VAULT_PATHS.index(v), join(VAULT_PATHS.dir(v), 'vault-index.db'));
  assert.equal(VAULT_PATHS.watchPid(v), join(VAULT_PATHS.dir(v), 'watch.pid'));
});

test('hasVaultIndex is false for an unindexed vault, true once the file exists', () => {
  const vault = mkdtempSync(join(tmpdir(), 'll-vault-paths-'));
  assert.equal(hasVaultIndex(vault), false, 'a vault with no .vault-search has no index');

  mkdirSync(VAULT_PATHS.dir(vault), { recursive: true });
  assert.equal(hasVaultIndex(vault), false, 'an empty .vault-search dir is still no index');

  writeFileSync(VAULT_PATHS.index(vault), '');
  assert.equal(hasVaultIndex(vault), true);

  assert.equal(hasVaultIndex(null), false, 'no vault is not an indexed vault');
  assert.equal(hasVaultIndex(undefined), false);
});

// The no-index behaviour of intentions() itself is pinned in
// vault-search-session-start-refresh.test.mjs, which also asserts the binary is
// never invoked. Not restated here.

const JS_EXT = /\.(js|mjs)$/;

// `git ls-files 'plugin/**/*.mjs'` silently skipped files directly under
// `plugin/`: a git pathspec is wildmatch WITHOUT WM_PATHNAME unless it carries
// `:(glob)` magic, so `**` behaves like `*` and the `/` after it is mandatory.
// The listing is unglobbed and the extension filter runs in JS, which has no
// notion of depth at all.
/** Every tracked JS/MJS file under `plugin/`, repo-relative, at any depth. */
function pluginSources() {
  return execFileSync('git', ['-C', ROOT, 'ls-files', '--', 'plugin'], {
    encoding: 'utf8',
    env: gitEnv(),
  })
    .trim()
    .split('\n')
    .filter(Boolean)
    .filter((rel) => JS_EXT.test(rel));
}

// paths.mjs is the one speller. Docs under plugin/ are prose a reader types by
// hand, not code that can drift out of agreement with the Rust side, so the
// sweep is scoped to sources.
const SPELLER = 'plugin/scripts/lib/paths.mjs';
const LITERALS = ['.vault-search', 'vault-index.db', 'watch.pid'];

// Prose that names the pidfile is documentation; it is code deriving the path a
// second way that drifts. So comments are exempt — but by SPAN, not by line.
// Dropping any line that merely *starts* with `/*` exempted the code after an
// inline `/** … */` prefix, and kept a block comment's continuation lines (which
// start with neither `*` nor `//`) in scope as if they were code.
//
// Block comments go first, so an inline one cannot shield the code beside it.
// Line comments stay whole-line-only on purpose: a line beginning with `//` is
// entirely prose and can hide nothing, whereas stripping every `//` tail would
// truncate a line at a URL and hide a literal sitting after it.
export function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

function codeOf(rel) {
  return stripComments(readFileSync(join(ROOT, rel), 'utf8'));
}

test('the sweep reaches the sources, and finds the directory named in them', () => {
  // A sweep that listed nothing would pass the rule below by looking at nothing.
  const sources = pluginSources();
  assert.ok(sources.length > 50, `swept only ${sources.length} plugin sources`);
  for (const expected of [
    SPELLER,
    'plugin/hooks/pre-write-check.js',
    'plugin/hooks/session-start/watch-daemon.mjs',
    'plugin/scripts/watch.mjs',
    'plugin/scripts/vault-search.mjs',
  ]) {
    assert.ok(sources.includes(expected), `the sweep must reach ${expected}`);
  }
  const speller = codeOf(SPELLER);
  for (const lit of LITERALS) {
    assert.ok(speller.includes(lit), `the sweep must find ${lit} where it is allowed`);
  }
});

test('the selection is depth-independent, so a file directly under plugin/ is in scope', () => {
  // There is no such file today, which is exactly why the old glob's miss was
  // invisible. Pin the selector rather than the tree: nothing in the pipeline
  // may consult depth.
  assert.ok(JS_EXT.test('plugin/top.mjs'), 'a top-level plugin source must qualify');
  assert.ok(JS_EXT.test('plugin/scripts/lib/deep.mjs'), 'so must a deeply nested one');
  assert.ok(!JS_EXT.test('plugin/skills/init/SKILL.md'), 'and markdown must not');
  const args = pluginSources.toString();
  assert.ok(
    !args.includes('**'),
    'a ** pathspec is not depth-agnostic in git; list unglobbed and filter in JS',
  );
});

test('stripComments exempts comment spans, not whole lines', () => {
  // Finding 3: code hidden behind an inline block comment must stay visible.
  assert.match(
    stripComments(
      "/** @type {(v: string) => string} */ export const p = (v) => q(v, '.vault-search');",
    ),
    /\.vault-search/,
    'an inline /** … */ prefix must not exempt the code beside it',
  );
  // Finding 4: a block comment's continuation line is prose, not code.
  assert.doesNotMatch(
    stripComments(
      '/* The daemon writes its pidfile to\n   .vault-search/watch.pid next to it. */\nexport const a = 1;',
    ),
    /\.vault-search/,
    "a block comment's continuation line must be exempt",
  );
  // A whole-line // comment is prose.
  assert.doesNotMatch(stripComments('// mentions .vault-search in prose'), /\.vault-search/);
  // But a // tail must not truncate the code before it, or a literal sitting
  // after a URL would hide.
  assert.match(
    stripComments("const u = 'https://x'; const p = q('.vault-search'); // see https://y"),
    /\.vault-search/,
    'a // tail must not truncate the code before it',
  );
});

test('nothing under plugin/ spells these paths except paths.mjs', () => {
  const sources = pluginSources().filter((rel) => rel !== SPELLER);
  for (const lit of LITERALS) {
    const offenders = sources.filter((rel) => codeOf(rel).includes(lit));
    assert.deepEqual(
      offenders,
      [],
      `derive from VAULT_PATHS/DATA_FILES instead of spelling ${lit}: ${offenders.join(', ')}`,
    );
  }
});
