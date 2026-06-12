// The installed plugin is plugin/'s contents verbatim — the repo root
// package.json does NOT ship. Hooks must therefore load as ESM without
// inheriting "type": "module" from an ancestor: Node ≥22 falls back to
// per-process syntax detection with a stderr warning on every hook fire
// ("Failed to load the ES module: ... Make sure to set \"type\": \"module\""),
// and runtimes without detection hard-fail. These tests run each hook from
// a copy of plugin/ outside the repo with detection disabled, so module
// type must be explicit, not inferred.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_PLUGIN = fileURLToPath(new URL('../plugin', import.meta.url));
const MODULE_LOAD_WARNING =
  /Failed to load the ES module|To load an ES module|epars(?:ed|ing) as (?:an )?ES module|Cannot use import statement outside a module|MODULE_TYPELESS/i;

let sandbox;
let installedPlugin;

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'll-esm-'));
  installedPlugin = join(sandbox, 'plugin');
  cpSync(REPO_PLUGIN, installedPlugin, { recursive: true });
});

after(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function hookFilesFromHooksJson(pluginRoot) {
  const hooksJson = readFileSync(join(pluginRoot, 'hooks', 'hooks.json'), 'utf8');
  const files = [...hooksJson.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([\w./-]+)/g)].map((m) => m[1]);
  return [...new Set(files)];
}

test('every hooks.json hook loads as ESM from an installed-layout plugin copy', () => {
  const files = hookFilesFromHooksJson(installedPlugin);
  assert.ok(files.length >= 8, `expected at least 8 hook files in hooks.json, got ${files.length}`);
  for (const file of files) {
    const res = spawnSync(
      process.execPath,
      ['--no-experimental-detect-module', join(installedPlugin, file)],
      { input: '{}', cwd: sandbox, encoding: 'utf8', timeout: 15000 },
    );
    assert.ok(
      !MODULE_LOAD_WARNING.test(res.stderr),
      `${file} emitted a module-load warning:\n${res.stderr}`,
    );
  }
});

test('plugin/package.json pins type module and carries no version for release.sh to bump', () => {
  const pkg = JSON.parse(readFileSync(join(REPO_PLUGIN, 'package.json'), 'utf8'));
  assert.equal(pkg.type, 'module');
  assert.ok(!('version' in pkg), 'a version field here would desync from plugin.json on release');
});
