// tests/download-binary-version.test.mjs : getVersion in scripts/download-binary.mjs.
//
// Pins that the downloader derives its release tag from the plugin manifest
// (.claude-plugin/plugin.json), NOT package.json — post-W6-move package.json
// stays at the repo root outside the installed plugin, so a package.json read
// would silently degrade to 'latest' for installed users.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MOD_PATH = fileURLToPath(new URL('../plugin/scripts/download-binary.mjs', import.meta.url));
const MOD = JSON.stringify(MOD_PATH);

// Spawned so argv is controlled (getVersion short-circuits on process.argv[2])
// and so an unguarded top-level main() can't run inside the test process.
function getVersionInSubprocess(root, env = {}) {
  return spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `
      const m = await import(${MOD});
      console.log(m.getVersion(${JSON.stringify(root)}));
    `],
    { encoding: 'utf-8', env: { ...process.env, ...env } },
  );
}

test('getVersion derives from .claude-plugin/plugin.json, not package.json', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'll-dlver-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'learning-loop', version: '9.9.9' }),
  );

  const out = getVersionInSubprocess(root);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout.trim(), 'v9.9.9');
});

test('getVersion falls back to latest when plugin.json is absent', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'll-dlver-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const out = getVersionInSubprocess(root);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout.trim(), 'latest');
});

// Regression: the detached session-start spawn runs in a stripped environment.
// When neither CLAUDE_PLUGIN_DATA nor the saved data-path marker resolves,
// main() must exit 1 with a clear message — NOT throw join(null) into ignored
// stdio, which left .version unwritten and the next session re-spawning the
// download forever (the stuck-auto-update loop). Hermetic env: empty HOME so no
// ~/.claude/.ll-data-path marker exists, and CLAUDE_PLUGIN_DATA unset.
test('download-binary exits cleanly (not a throw) when no plugin-data resolves', (t) => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'll-dl-nohome-'));
  t.after(() => rmSync(fakeHome, { recursive: true, force: true }));

  // Pass a version arg so getVersion() short-circuits before any network call;
  // the plugin-data guard must fire first regardless.
  const out = spawnSync(process.execPath, [MOD_PATH, 'v9.9.9'], {
    encoding: 'utf-8',
    env: { PATH: process.env.PATH, HOME: fakeHome, USERPROFILE: fakeHome },
  });

  assert.equal(out.status, 1, `expected clean exit 1; stderr: ${out.stderr}`);
  assert.doesNotMatch(
    out.stderr,
    /ERR_INVALID_ARG_TYPE|Received null/,
    'must not throw an uncaught join(null) TypeError',
  );
  assert.match(out.stderr, /no saved data path|CLAUDE_PLUGIN_DATA not set/i);
});
