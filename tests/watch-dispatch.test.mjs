import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'watch.mjs');

function runWatch(...args) {
  return spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf-8',
    timeout: 5000,
    env: { ...process.env, CLAUDE_PLUGIN_DATA: '/dev/null/should-not-be-read' },
  });
}

describe('ll-watch dispatcher', () => {
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
