import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dirname, '..', 'plugin', 'scripts', 'watch.mjs');
const HOME = mkdtempSync(join(tmpdir(), 'll-watch-dispatch-'));

function runWatch(...args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf-8',
    timeout: 5000,
    env: {
      PATH: process.env.PATH,
      HOME,
      USERPROFILE: HOME,
      CLAUDE_PLUGIN_DATA: join(HOME, 'no-plugin-data'),
    },
  });
}

describe('ll-watch dispatcher', () => {
  after(() => rmSync(HOME, { recursive: true, force: true }));

  it('--help prints usage and exits 0', () => {
    const r = runWatch('--help');
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /^Usage:/m);
    assert.match(r.stdout, /ll-watch stop/);
    assert.match(r.stdout, /ll-watch status/);
  });

  it('-h is an alias for --help', () => {
    const r = runWatch('-h');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^Usage:/m);
  });

  it('help (no dashes) is an alias for --help', () => {
    const r = runWatch('help');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^Usage:/m);
  });

  it('"start" is a synonym for the bare form', () => {
    // Same env-forced failure the bare form hits (no vault_path resolvable),
    // reached only past the unknown-command guard -- proves "start" dispatches
    // like the bare form instead of being rejected as unknown.
    const bare = runWatch();
    const start = runWatch('start');
    assert.equal(start.status, bare.status);
    assert.equal(start.stderr, bare.stderr);
    assert.doesNotMatch(start.stderr, /unknown command/);
  });

  it('--help lists "start" as a synonym for the bare form', () => {
    const r = runWatch('--help');
    assert.match(r.stdout, /ll-watch start/);
  });

  it('unknown command exits 2 with "unknown command:" on stderr', () => {
    const r = runWatch('bogus');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown command: bogus/);
    assert.match(r.stderr, /Usage:/);
  });

  it('typo on a real subcommand is rejected, not silently started', () => {
    // Regression: pre-fix, "stp" / "statu" / "--foregrond" all spawned a watcher.
    for (const typo of ['stp', 'statu', '--foregrond']) {
      const r = runWatch(typo);
      assert.equal(r.status, 2, `"${typo}" should be rejected, got ${r.status}`);
      assert.match(r.stderr, new RegExp(`unknown command: ${typo.replace(/[-]/g, '\\-')}`));
    }
  });
});
