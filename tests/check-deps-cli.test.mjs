import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dirname, '..', 'plugin', 'scripts', 'check-deps.mjs');

// A throwaway HOME and plugin data, so the report reads neither the developer's
// config nor their installed_plugins.json.
function runCli({ config, installed } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'll-check-deps-'));
  try {
    const dataDir = join(home, 'plugin-data');
    mkdirSync(dataDir);
    if (config) writeFileSync(join(dataDir, 'config.json'), JSON.stringify(config));
    if (installed) {
      mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
      writeFileSync(
        join(home, '.claude', 'plugins', 'installed_plugins.json'),
        JSON.stringify({ plugins: installed }),
      );
    }
    const out = execFileSync(process.execPath, [CLI], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, CLAUDE_PLUGIN_DATA: dataDir },
    });
    return JSON.parse(out);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// An empty list, not a missing config.json: with none in plugin data, the
// config falls back to the plugin's shipped one, which declares dependencies.
test('check-deps prints only _abi_drift when no dependencies are configured', () => {
  assert.deepEqual(runCli({ config: { dependencies: [] } }), { _abi_drift: [] });
});

// Regression: check-deps used to load PLUGIN_DIR/config.json directly, so an
// install whose config lives only at PLUGIN_DATA/config.json got an empty
// dependency report with exit 0: dependency checking silently off.
test('check-deps reads config from PLUGIN_DATA and reports each dependency', () => {
  const dep = (name, version) => ({ name, marketplace: 'mk', required: true, version });
  const obj = runCli({
    config: {
      dependencies: [dep('absent', '>=1.0.0'), dep('old', '>=1.10.0'), dep('current', '>=1.10.0')],
    },
    installed: {
      'old@mk': [{ version: '1.9.9' }],
      'current@mk': [{ version: '1.10.0' }],
    },
  });
  assert.equal(obj.absent.status, 'missing');
  assert.equal(obj.old.status, 'outdated');
  assert.equal(obj.current.status, 'installed');
  for (const k of ['absent', 'old', 'current']) {
    assert.equal(obj[k].marketplace, 'mk');
    assert.equal(obj[k].required, true);
  }
  assert.deepEqual(obj._abi_drift, []);
});
