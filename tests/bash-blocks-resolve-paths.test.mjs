// tests/bash-blocks-resolve-paths.test.mjs
//
// `${CLAUDE_PLUGIN_ROOT}` is filled in by ONE thing: the Skill tool, when it
// loads a `SKILL.md`. It is not an environment variable — a Bash tool shell has
// no such name — so a file the Skill tool never loads arrives through `Read`
// with the placeholder intact, and a Bash block carrying it runs against the
// empty string.
//
// That failure is silent, which is why it lasted months. `eval "$(node
// "${CLAUDE_PLUGIN_ROOT}/scripts/resolve-paths.mjs" --sh)"` becomes `node
// "/scripts/resolve-paths.mjs"`; node exits non-zero, `eval` consumes nothing,
// every resolved variable stays unset, and `"${REFLECT_SCRATCH}/ll-${SESSION_ID}-reflect"`
// resolves to `/ll--reflect`. The step then reads and writes at the filesystem
// root, and nothing in the output says so.
//
// **The rule has no exception, and that is deliberate.** A `SKILL.md` could
// get away with the placeholder, because the loader substitutes into it. But
// an exception is exactly how this bug travels: the natural way to write a
// step file is to copy a working block out of the SKILL.md that calls it, and
// the copy is broken the moment it lands. So every Bash block under `plugin/`
// resolves the same way — `eval "$(ll-paths --sh)"`, then `"$PLUGIN/..."` —
// and the shim needs no environment, which is the whole point of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = join(import.meta.dirname, '..');

const PLACEHOLDER = '${CLAUDE_PLUGIN_ROOT}';

/** Every tracked markdown file under `plugin/`, repo-relative. */
function pluginDocs() {
  return execFileSync('git', ['-C', ROOT, 'ls-files', 'plugin/**/*.md'], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean);
}

/** The shell blocks in a markdown file, as strings. */
function shellBlocks(md) {
  return [...md.matchAll(/```(?:bash|sh|shell)\n([\s\S]*?)```/g)].map((m) => m[1]);
}

test('the sweep reaches the files, and finds shell in them', () => {
  // A sweep that listed nothing, or found no shell blocks, would pass the
  // assertions below by looking at nothing at all.
  const docs = pluginDocs();
  assert.ok(docs.length > 50, `swept only ${docs.length} plugin docs`);
  for (const expected of [
    'plugin/skills/reflect/steps/refinement.md',
    'plugin/skills/reflect/SKILL.md',
    'plugin/agents/note-verifier.md',
    'plugin/agents-shared/vault-io.md',
    'plugin/skills-shared/paths-preamble.md',
  ]) {
    assert.ok(docs.includes(expected), `the sweep must reach ${expected}`);
  }
  const blocks = docs.flatMap((rel) => shellBlocks(readFileSync(join(ROOT, rel), 'utf8')));
  assert.ok(blocks.length > 100, `extracted only ${blocks.length} shell blocks`);
});

test('no shell block under plugin/ writes ${CLAUDE_PLUGIN_ROOT}', () => {
  const offenders = [];
  for (const rel of pluginDocs()) {
    for (const block of shellBlocks(readFileSync(join(ROOT, rel), 'utf8'))) {
      const n = block.split(PLACEHOLDER).length - 1;
      if (n) offenders.push(`${rel}: ${n} occurrence(s) — use \`eval "$(ll-paths --sh)"\` and "$PLUGIN/..."`);
    }
  }
  assert.deepEqual(offenders.sort(), [], `unsubstitutable placeholders:\n${offenders.join('\n')}`);
});

test('a block that uses $PLUGIN is the block that resolves it', () => {
  // Each Bash tool call is its own shell, so a variable set in one block is
  // gone by the next. A block that reads `$PLUGIN` without the bootstrap
  // fails exactly the way the placeholder did — expanding to nothing, quietly.
  const offenders = [];
  for (const rel of pluginDocs()) {
    for (const block of shellBlocks(readFileSync(join(ROOT, rel), 'utf8'))) {
      const usesPlugin = /\$\{?PLUGIN\}?(?!_DATA)\b/.test(block);
      if (usesPlugin && !block.includes('ll-paths --sh')) {
        offenders.push(`${rel}: uses $PLUGIN without \`eval "$(ll-paths --sh)"\``);
      }
    }
  }
  assert.deepEqual(offenders.sort(), [], `unresolved $PLUGIN:\n${offenders.join('\n')}`);
});

test('the shim the rule points at is one install-shims.mjs actually writes', () => {
  // The rule above is only as real as the command it names. An install script
  // that stopped writing `ll-paths` would leave every converted block calling
  // something that does not exist — and the placeholder sweep would stay green
  // through it, because the placeholder would still be absent.
  const src = readFileSync(join(ROOT, 'plugin', 'scripts', 'install-shims.mjs'), 'utf8');
  assert.match(src, /shimPath\('ll-paths'\)/, 'install-shims.mjs must write ll-paths');
  assert.match(src, /exec node "\\\$\{LATEST\}scripts\/resolve-paths\.mjs"/,
    'the POSIX shim must exec resolve-paths.mjs');
  assert.match(src, /node "!LATEST!\\\\scripts\\\\resolve-paths\.mjs" %\*/,
    'and so must the .cmd, or the guard stops guarding on Windows');
});
