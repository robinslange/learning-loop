import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECK_IDS, SEVERITIES, makeCheck } from '../scripts/lib/health-checks/types.mjs';

test('CHECK_IDS exports the documented quick + full check IDs', () => {
  const quick = [
    'vault-path', 'vault-folders', 'vault-system-files',
    'binary-exists', 'binary-version-file',
    'shims-exist', 'local-bin-on-path',
    'claudemd-section-present', 'claudemd-section-current',
    'installed-plugins-readable', 'plugin-cache-version-present',
    'search-index-exists', 'nli-socket-fresh', 'abi-drift',
  ];
  const full = [
    'node-version', 'claude-version',
    'episodic-memory-installed', 'learning-loop-installed',
    'binary-runs', 'watch-daemon-status',
  ];
  for (const id of [...quick, ...full]) {
    assert.ok(CHECK_IDS[id] === id, `missing id: ${id}`);
  }
});

test('SEVERITIES has ok, warn, fail', () => {
  assert.equal(SEVERITIES.ok, 'ok');
  assert.equal(SEVERITIES.warn, 'warn');
  assert.equal(SEVERITIES.fail, 'fail');
});

test('makeCheck returns the expected shape', () => {
  const c = makeCheck({
    id: 'vault-path',
    name: 'Vault path',
    status: 'fail',
    severity: 'fail',
    detail: 'directory missing',
    fix: 'Run /learning-loop:init',
  });
  assert.deepEqual(c, {
    id: 'vault-path',
    name: 'Vault path',
    status: 'fail',
    severity: 'fail',
    detail: 'directory missing',
    fix: 'Run /learning-loop:init',
  });
});

test('makeCheck status=ok forces fix=null', () => {
  const c = makeCheck({
    id: 'vault-path',
    name: 'Vault path',
    status: 'ok',
    severity: 'fail',
    detail: 'present',
    fix: 'irrelevant',
  });
  assert.equal(c.fix, null);
});
