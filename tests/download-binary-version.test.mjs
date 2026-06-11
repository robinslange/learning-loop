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

const MOD = JSON.stringify(
  fileURLToPath(new URL('../plugin/scripts/download-binary.mjs', import.meta.url)),
);

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
