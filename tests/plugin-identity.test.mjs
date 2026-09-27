// tests/plugin-identity.test.mjs : the plugin's identity (name, marketplace,
// version) is spelled once and agrees everywhere it has to be copied.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { renderShim } from '../plugin/scripts/lib/shims.mjs';
import { SHIM_NAMES } from '../plugin/scripts/lib/paths.mjs';
import {
  PLUGIN_NAME,
  MARKETPLACE_NAME,
  INSTALL_KEY,
  DATA_DIR_NAME,
  cacheRoot,
} from '../plugin/scripts/lib/plugin-meta.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

const pkg = readJson('package.json');
const claude = readJson('plugin/.claude-plugin/plugin.json');
const codex = readJson('plugin/.codex-plugin/plugin.json');
const market = readJson('.claude-plugin/marketplace.json');

// [package] version of every crate released with the plugin. ll-core follows
// its own crates.io semver line and is bumped by hand (release.sh skips it).
function releasedCrateVersions() {
  const dir = join(ROOT, 'native', 'crates');
  return readdirSync(dir)
    .filter((c) => c !== 'll-core' && existsSync(join(dir, c, 'Cargo.toml')))
    .map((c) => {
      const toml = readFileSync(join(dir, c, 'Cargo.toml'), 'utf8');
      const section = toml.split(/^\[package\]\s*$/m)[1]?.split(/^\[/m)[0] ?? '';
      return [c, section.match(/^version\s*=\s*"([^"]+)"/m)?.[1]];
    });
}

const MARKETPLACE_LITERAL = 'learning-loop-marketplace';
const tracked = (...pathspecs) =>
  execFileSync('git', ['ls-files', '-z', '--', ...pathspecs], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
const spells = (file) => readFileSync(join(ROOT, file), 'utf8').includes(MARKETPLACE_LITERAL);

describe('the marketplace name is spelled once', () => {
  test('no plugin or bench code outside plugin-meta spells it', () => {
    const offenders = tracked('plugin/*.js', 'plugin/*.mjs', 'plugin/*.cjs', 'bench/*.mjs')
      .filter((f) => f !== 'plugin/scripts/lib/plugin-meta.mjs')
      .filter(spells);
    assert.deepEqual(offenders, []);
  });

  for (const script of ['install.sh', 'release.sh']) {
    test(`${script} spells it only on its readonly line, with values matching plugin-meta`, () => {
      const lines = readFileSync(join(ROOT, script), 'utf8').split('\n');
      const spelled = lines.filter((l) => l.includes(MARKETPLACE_LITERAL));
      assert.deepEqual(
        spelled.map((l) => l.trim()),
        [`readonly LL_MARKETPLACE="${MARKETPLACE_NAME}"`],
      );
      const plugin = lines
        .map((l) => l.match(/^\s*readonly LL_PLUGIN="([^"]*)"$/)?.[1])
        .find(Boolean);
      assert.equal(plugin, PLUGIN_NAME);
    });
  }
});

describe('shim text', () => {
  // Installed shims are rewritten whenever this text changes, so a refactor
  // that moves where the text comes from must not move a single byte.
  // After an intentional shim change, regenerate the fixture from the repo root:
  // node --input-type=module -e "import{writeFileSync}from'node:fs';import{renderShim}from'./plugin/scripts/lib/shims.mjs';import{SHIM_NAMES}from'./plugin/scripts/lib/paths.mjs';const s={};for(const p of['linux','win32'])for(const n of SHIM_NAMES)s[n+'.'+p]=renderShim(n,p);writeFileSync('tests/fixtures/shim-snapshots.json',JSON.stringify(s,null,2)+'\n')"
  const snapshots = readJson('tests/fixtures/shim-snapshots.json');
  for (const platform of ['linux', 'win32']) {
    for (const name of SHIM_NAMES) {
      test(`${name} on ${platform} renders byte-identical to its snapshot`, () => {
        assert.equal(renderShim(name, platform), snapshots[`${name}.${platform}`]);
      });
    }
  }
});

describe('version lockstep', () => {
  test('both plugin manifests carry the package.json version', () => {
    assert.equal(claude.version, pkg.version, 'plugin/.claude-plugin/plugin.json');
    assert.equal(codex.version, pkg.version, 'plugin/.codex-plugin/plugin.json');
  });

  test('every released crate carries the package.json version', () => {
    const crates = releasedCrateVersions();
    assert.ok(crates.length > 0, 'found no crates under native/crates');
    for (const [crate, version] of crates) {
      assert.equal(version, pkg.version, `native/crates/${crate}/Cargo.toml`);
    }
  });

  test('marketplace entries leave the version to plugin.json', () => {
    for (const entry of market.plugins) {
      assert.ok(!('version' in entry), `marketplace entry ${entry.name} sets version`);
    }
  });
});

describe('manifest parity', () => {
  test('the Claude and Codex manifests agree on identity fields', () => {
    for (const field of ['name', 'version', 'author', 'license', 'repository']) {
      assert.deepEqual(codex[field], claude[field], field);
    }
  });

  test('the marketplace entry name is the manifest name', () => {
    assert.deepEqual(
      market.plugins.map((p) => p.name),
      [claude.name],
    );
  });
});

describe('identity constants', () => {
  test('are pinned to the manifests', () => {
    assert.equal(PLUGIN_NAME, claude.name);
    assert.equal(MARKETPLACE_NAME, market.name);
    assert.equal(INSTALL_KEY, `${claude.name}@${market.name}`);
  });

  test('DATA_DIR_NAME is the folder Claude Code creates for this install', () => {
    assert.equal(DATA_DIR_NAME, 'learning-loop-learning-loop-marketplace');
  });

  test('cacheRoot is <home>/<dot>/plugins/cache/<marketplace>/<plugin>', () => {
    assert.equal(
      cacheRoot('/h', '.codex'),
      join('/h', '.codex', 'plugins', 'cache', 'learning-loop-marketplace', 'learning-loop'),
    );
  });
});
