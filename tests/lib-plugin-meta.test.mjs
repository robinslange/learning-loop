import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  pluginRoot,
  pluginVersion,
  pluginId,
  dataDir,
  cacheDir,
} from '../scripts/lib/plugin-meta.mjs';

const MOD = JSON.stringify(
  fileURLToPath(new URL('../scripts/lib/plugin-meta.mjs', import.meta.url)),
);

test('pluginRoot resolves to repo root', () => {
  const root = pluginRoot();
  // Should end with /learning-loop (direct or worktree checkout).
  assert.match(root, /learning-loop(\/\.worktrees\/[^/]+)?$/);
});

test('pluginRoot is an absolute path', () => {
  assert.ok(pluginRoot().startsWith('/'));
});

test('pluginVersion reads version from package.json', () => {
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
    ['--input-type=module', '-e', `
      const m = await import(${MOD});
      console.log(m.dataDir());
    `],
    { env: { ...process.env, CLAUDE_PLUGIN_DATA: '/tmp/llcustom' } },
  );
  assert.equal(out.status, 0, out.stderr.toString());
  assert.equal(out.stdout.toString().trim(), '/tmp/llcustom');
});

test('dataDir defaults to ~/.claude/plugins/data/learning-loop (subprocess)', () => {
  const out = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `
      const m = await import(${MOD});
      console.log(m.dataDir());
    `],
    { env: { ...process.env, CLAUDE_PLUGIN_DATA: undefined } },
  );
  assert.equal(out.status, 0, out.stderr.toString());
  assert.match(out.stdout.toString().trim(), /\.claude\/plugins\/data\/learning-loop$/);
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
    assert.ok(c.endsWith('/cache'));
  }
});
