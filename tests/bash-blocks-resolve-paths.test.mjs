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
// resolves the same way: `ll-run <script>` to run something, `ll-paths <FIELD>`
// to name a path. Both are commands on PATH and need no environment, which is
// the whole point of them.
//
// The one-spawn shorthand `eval "$(ll-paths --sh)"` is banned here too, and
// for a second reason. The worktree isolation guard refuses a command it
// cannot statically verify, and `eval` of a command substitution is the
// canonical example — so under worktree isolation the bootstrap line was
// refused and every skill that opened with it died at its first fence.
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
      if (n) offenders.push(`${rel}: ${n} occurrence(s) — use \`ll-run <script>\` or \`ll-paths <FIELD>\``);
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
      if (usesPlugin && !/^\s*PLUGIN="\$\(ll-paths PLUGIN\)"/m.test(block)) {
        offenders.push(`${rel}: uses $PLUGIN without \`PLUGIN="$(ll-paths PLUGIN)"\``);
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
  assert.match(src, /shimPath\('ll-run'\)/, 'install-shims.mjs must write ll-run');
  assert.match(src, /exec node "\\\$SCRIPT" "\$@"/, 'the POSIX ll-run must exec the named script');
  assert.match(src, /node "!SCRIPT!" !ARGS!/, 'and so must the .cmd');
});

test('a shim the rule names is a shim SHIM_NAMES carries', () => {
  // SessionStart re-runs the installer only when a shim it knows about is
  // missing. A shim added to install-shims.mjs alone reaches no existing
  // install: they all have ll-watch/ll-search/ll-paths already, so the check
  // passes and ll-run never lands.
  const src = readFileSync(join(ROOT, 'plugin', 'scripts', 'lib', 'paths.mjs'), 'utf8');
  const m = src.match(/export const SHIM_NAMES = \[([^\]]*)\]/);
  assert.ok(m, 'SHIM_NAMES must exist in scripts/lib/paths.mjs');
  for (const name of ['ll-watch', 'll-search', 'll-paths', 'll-run']) {
    assert.ok(m[1].includes(`'${name}'`), `SHIM_NAMES must carry ${name}`);
  }
});

test('no shell block under plugin/ evals a resolver', () => {
  // `eval "$(...)"` is refused outright by the worktree isolation guard, which
  // cannot statically verify it. One such line at the top of a skill takes the
  // whole skill down in any worktree session. It also swallows the resolver's
  // own failure: eval of a command that died consumes nothing, leaving every
  // name unset and the next line building a path out of empty strings.
  const offenders = [];
  for (const rel of pluginDocs()) {
    for (const block of shellBlocks(readFileSync(join(ROOT, rel), 'utf8'))) {
      if (/\beval\s+"\$\(/.test(block)) {
        offenders.push(`${rel}: eval of a command substitution — use \`ll-run\` / \`ll-paths <FIELD>\``);
      }
    }
  }
  assert.deepEqual(offenders.sort(), [], `evalled resolvers:\n${offenders.join('\n')}`);
});

test('a block that uses a resolver field is the block that resolves it', () => {
  // Each Bash tool call is its own shell. Naming exactly the fields a block
  // uses is what replaced the one-line eval, so the check that used to look
  // for that line now looks for the assignments themselves.
  const FIELDS = [
    'PLUGIN_DATA', 'VAULT', 'SESSION_ID',
    'REFLECT_SCRATCH', 'REFLECT_PREFIX', 'LAST_DREAM', 'LAST_REFLECT', 'DREAM_LOCK',
  ];
  const offenders = [];
  for (const rel of pluginDocs()) {
    for (const block of shellBlocks(readFileSync(join(ROOT, rel), 'utf8'))) {
      const lines = block.split('\n');
      for (const field of FIELDS) {
        const use = lines.findIndex((l) => new RegExp(`\\$\\{?${field}\\b`).test(l));
        if (use === -1) continue;
        const assigned = lines
          .slice(0, use + 1)
          .some((l) => new RegExp(`^\\s*(export )?${field}=`).test(l));
        if (!assigned) offenders.push(`${rel}: uses $${field} before assigning it`);
      }
    }
  }
  assert.deepEqual([...new Set(offenders)].sort(), [], `unresolved fields:\n${offenders.join('\n')}`);
});
