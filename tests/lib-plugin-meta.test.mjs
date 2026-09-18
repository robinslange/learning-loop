import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, isAbsolute, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  pluginRoot,
  pluginVersion,
  pluginId,
  dataDir,
  cacheDir,
  activeRoot,
  INSTALL_KEY,
} from '../plugin/scripts/lib/plugin-meta.mjs';

const MOD = JSON.stringify(new URL('../plugin/scripts/lib/plugin-meta.mjs', import.meta.url).href);

test('pluginRoot resolves to the plugin root', () => {
  const root = pluginRoot().replace(/\\/g, '/');
  // Structural assertion, not a directory-name one: a checkout is free to be
  // named anything (clone, worktree, CI scratch dir), so the test asserts the
  // relationship that defines the plugin root instead: it ends in /plugin and
  // carries the manifest.
  assert.match(root, /\/plugin$/);
  assert.ok(existsSync(join(root, '.claude-plugin/plugin.json')), `${root} has no plugin manifest`);
});

test('pluginRoot is an absolute path', () => {
  assert.ok(isAbsolute(pluginRoot()));
});

test('pluginVersion reads version from .claude-plugin/plugin.json', () => {
  const v = pluginVersion();
  assert.match(v, /^\d+\.\d+\.\d+/);
});

test('pluginId formats as name@version', () => {
  const id = pluginId();
  assert.match(id, /^learning-loop@\d+\.\d+\.\d+/);
});

test('dataDir honours CLAUDE_PLUGIN_DATA env var (subprocess)', () => {
  const out = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
      const m = await import(${MOD});
      console.log(m.dataDir());
    `,
    ],
    { env: { ...process.env, CLAUDE_PLUGIN_DATA: '/tmp/llcustom' } },
  );
  assert.equal(out.status, 0, out.stderr.toString());
  assert.equal(out.stdout.toString().trim(), '/tmp/llcustom');
});

test('dataDir defaults to ~/.claude/plugins/data/learning-loop (subprocess)', () => {
  const out = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
      const m = await import(${MOD});
      console.log(m.dataDir());
    `,
    ],
    { env: { ...process.env, CLAUDE_PLUGIN_DATA: undefined } },
  );
  assert.equal(out.status, 0, out.stderr.toString());
  assert.match(
    out.stdout.toString().trim().replace(/\\/g, '/'),
    /\.claude\/plugins\/data\/learning-loop$/,
  );
});

test('cacheDir is dataDir + /cache', () => {
  const d = dataDir();
  const c = cacheDir();
  if (d !== null) {
    assert.equal(c, join(d, 'cache'));
  } else {
    assert.equal(c, null);
  }
});

test('cacheDir ends with /cache', () => {
  const c = cacheDir();
  if (c !== null) {
    assert.equal(basename(c), 'cache');
  }
});

function cacheFixture() {
  const home = mkdtempSync(join(tmpdir(), 'll-active-root-'));
  const parent = join(
    home,
    '.claude',
    'plugins',
    'cache',
    'learning-loop-marketplace',
    'learning-loop',
  );
  const old = join(parent, '2.0.6');
  const current = join(parent, '2.0.7');
  for (const root of [old, current]) {
    mkdirSync(join(root, 'hooks'), { recursive: true });
    writeFileSync(join(root, 'hooks', 'stop-nudge.js'), '');
  }
  const install = (installPath) =>
    writeFileSync(
      join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { [INSTALL_KEY]: [{ scope: 'user', installPath }] } }),
    );
  return {
    home,
    old,
    current,
    install,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

test('activeRoot follows the installed sibling version', () => {
  const fx = cacheFixture();
  try {
    fx.install(fx.current);
    const root = activeRoot({ need: 'hooks/stop-nudge.js', selfRoot: fx.old, home: fx.home });
    assert.equal(root, fx.current);
  } finally {
    fx.cleanup();
  }
});

test('activeRoot stays on its own version for a file the installed version dropped', () => {
  const fx = cacheFixture();
  try {
    writeFileSync(join(fx.old, 'hooks', 'retired.js'), '');
    fx.install(fx.current);
    const root = activeRoot({ need: 'hooks/retired.js', selfRoot: fx.old, home: fx.home });
    assert.equal(root, fx.old);
  } finally {
    fx.cleanup();
  }
});

test('activeRoot ignores an install that is not a sibling (Codex cache, --plugin-dir)', () => {
  const fx = cacheFixture();
  try {
    const elsewhere = join(
      fx.home,
      '.codex',
      'plugins',
      'cache',
      'learning-loop-marketplace',
      'learning-loop',
      '2.0.7',
    );
    mkdirSync(join(elsewhere, 'hooks'), { recursive: true });
    writeFileSync(join(elsewhere, 'hooks', 'stop-nudge.js'), '');
    fx.install(elsewhere);
    const root = activeRoot({ need: 'hooks/stop-nudge.js', selfRoot: fx.old, home: fx.home });
    assert.equal(root, fx.old);
  } finally {
    fx.cleanup();
  }
});

test('activeRoot stays on its own version when Claude Code has no install record', () => {
  const fx = cacheFixture();
  try {
    const root = activeRoot({ need: 'hooks/stop-nudge.js', selfRoot: fx.old, home: fx.home });
    assert.equal(root, fx.old);
  } finally {
    fx.cleanup();
  }
});
