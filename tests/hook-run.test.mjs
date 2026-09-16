// hooks/run.mjs is the entry for every hooks.json command. An open session is
// pinned to the version directory it loaded; run.mjs must hand each hook call to
// the version Claude Code has installed, with argv and stdin exactly as if the
// hook had been launched directly.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSTALL_KEY } from '../plugin/scripts/lib/plugin-meta.mjs';

const REPO_PLUGIN = fileURLToPath(new URL('../plugin', import.meta.url));
const PROBE =
  "let s = ''; process.stdin.on('data', (d) => (s += d)); process.stdin.on('end', () => " +
  'console.log(JSON.stringify({ dir: import.meta.dirname, argv1: process.argv[1], stdin: s })));\n';

let home;
let old;
let current;

before(() => {
  // realpath: import.meta.dirname is resolved, and macOS tmpdir() is a symlink.
  home = realpathSync(mkdtempSync(join(tmpdir(), 'll-hook-run-')));
  const parent = join(
    home,
    '.claude',
    'plugins',
    'cache',
    'learning-loop-marketplace',
    'learning-loop',
  );
  old = join(parent, '2.0.6');
  current = join(parent, '2.0.7');
  cpSync(REPO_PLUGIN, old, { recursive: true });
  mkdirSync(join(current, 'hooks'), { recursive: true });
  writeFileSync(join(current, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(old, 'hooks', 'probe.js'), PROBE);
  writeFileSync(join(current, 'hooks', 'probe.js'), PROBE);
  writeFileSync(
    join(home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: { [INSTALL_KEY]: [{ scope: 'user', installPath: current }] },
    }),
  );
});

after(() => rmSync(home, { recursive: true, force: true }));

function runFromOldSession(hook) {
  const r = spawnSync(process.execPath, [join(old, 'hooks', 'run.mjs'), hook], {
    input: '{"session_id":"s"}',
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('an old session runs the hook from the version Claude Code has installed', () => {
  const out = runFromOldSession('hooks/probe.js');
  assert.equal(out.dir, join(current, 'hooks'));
  assert.equal(
    out.argv1,
    join(current, 'hooks', 'probe.js'),
    'hookName() keys hooks.disabled on basename(argv[1])',
  );
  assert.equal(out.stdin, '{"session_id":"s"}');
});

test('a hook the installed version no longer ships runs from the session version', () => {
  writeFileSync(join(old, 'hooks', 'retired.js'), PROBE);
  assert.equal(runFromOldSession('hooks/retired.js').dir, join(old, 'hooks'));
});

test('every hook command enters through run.mjs with a root-relative handler', () => {
  const shape =
    /^cd "\$HOME" && node "\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/run\.mjs" hooks\/[a-z-]+\.js$/;
  for (const file of ['hooks.json', 'hooks.codex.json']) {
    const { hooks } = JSON.parse(readFileSync(join(REPO_PLUGIN, 'hooks', file), 'utf8'));
    for (const hook of Object.values(hooks)
      .flat()
      .flatMap((group) => group.hooks)) {
      assert.match(hook.command, shape, `${file}: ${hook.command}`);
    }
  }
});
