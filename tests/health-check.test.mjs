import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHECK_IDS, SEVERITIES, makeCheck } from '../scripts/lib/health-checks/types.mjs';
import {
  checkVaultPath,
  checkVaultFolders,
  checkVaultSystemFiles,
} from '../scripts/lib/health-checks/quick.mjs';

test('CHECK_IDS exports the documented quick + full check IDs', () => {
  const quick = [
    'vault-path',
    'vault-folders',
    'vault-system-files',
    'binary-exists',
    'binary-version-file',
    'shims-exist',
    'local-bin-on-path',
    'claudemd-section-present',
    'claudemd-section-current',
    'installed-plugins-readable',
    'plugin-cache-version-present',
    'search-index-exists',
    'nli-socket-fresh',
    'abi-drift',
  ];
  const full = [
    'node-version',
    'claude-version',
    'episodic-memory-installed',
    'learning-loop-installed',
    'binary-runs',
    'watch-daemon-status',
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

test('checkVaultPath: ok when directory exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-vault-'));
  const result = checkVaultPath({ vaultRoot: dir });
  assert.equal(result.status, 'ok');
  rmSync(dir, { recursive: true, force: true });
});

test('checkVaultPath: fail when vaultRoot is null', () => {
  const result = checkVaultPath({ vaultRoot: null });
  assert.equal(result.status, 'fail');
  assert.equal(result.severity, 'fail');
  assert.match(result.fix, /init/i);
});

test('checkVaultPath: fail when directory does not exist', () => {
  const result = checkVaultPath({ vaultRoot: '/does/not/exist/' + Date.now() });
  assert.equal(result.status, 'fail');
});

test('checkVaultFolders: ok when all 7 folders present', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-folders-'));
  for (const f of [
    '0-inbox',
    '1-fleeting',
    '2-literature',
    '3-permanent',
    '4-projects',
    '5-maps',
    '_system',
  ]) {
    mkdirSync(join(dir, f));
  }
  const result = checkVaultFolders({ vaultRoot: dir });
  assert.equal(result.status, 'ok');
  rmSync(dir, { recursive: true, force: true });
});

test('checkVaultFolders: fail with detail listing missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-folders-missing-'));
  mkdirSync(join(dir, '0-inbox')); // only 1 of 7
  const result = checkVaultFolders({ vaultRoot: dir });
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /1-fleeting/);
  rmSync(dir, { recursive: true, force: true });
});

test('checkVaultSystemFiles: ok when both files present', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-sysfiles-'));
  mkdirSync(join(dir, '_system'));
  writeFileSync(join(dir, '_system/persona.md'), 'voice');
  writeFileSync(join(dir, '_system/capture-rules.md'), 'rules');
  const result = checkVaultSystemFiles({ vaultRoot: dir });
  assert.equal(result.status, 'ok');
  rmSync(dir, { recursive: true, force: true });
});

test('checkVaultSystemFiles: warn when persona.md missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-sysfiles-missing-'));
  mkdirSync(join(dir, '_system'));
  writeFileSync(join(dir, '_system/capture-rules.md'), 'rules');
  const result = checkVaultSystemFiles({ vaultRoot: dir });
  assert.equal(result.status, 'fail');
  assert.equal(result.severity, 'warn');
  assert.match(result.detail, /persona\.md/);
  rmSync(dir, { recursive: true, force: true });
});
