import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHECK_IDS, SEVERITIES, makeCheck } from '../scripts/lib/health-checks/types.mjs';
import {
  checkVaultPath,
  checkVaultFolders,
  checkVaultSystemFiles,
  checkBinaryExists,
  checkBinaryVersionFile,
  checkShimsExist,
  checkLocalBinOnPath,
  checkClaudemdSectionPresent,
  checkClaudemdSectionCurrent,
  checkInstalledPluginsReadable,
  checkPluginCacheVersionPresent,
  checkSearchIndexExists,
  checkNliSocketFresh,
  checkAbiDrift,
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

test('checkBinaryExists: ok when binary present and executable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-bin-'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin/ll-search'), '#!/usr/bin/env bash\n');
  chmodSync(join(dir, 'bin/ll-search'), 0o755);
  const result = checkBinaryExists({ pluginData: dir });
  assert.equal(result.status, 'ok');
  rmSync(dir, { recursive: true, force: true });
});

test('checkBinaryExists: fail when binary missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-bin-missing-'));
  const result = checkBinaryExists({ pluginData: dir });
  assert.equal(result.status, 'fail');
  assert.match(result.fix, /init/i);
  rmSync(dir, { recursive: true, force: true });
});

test('checkBinaryVersionFile: warn when .version is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-binver-'));
  mkdirSync(join(dir, 'bin'));
  const result = checkBinaryVersionFile({ pluginData: dir });
  assert.equal(result.status, 'fail');
  assert.equal(result.severity, 'warn');
  rmSync(dir, { recursive: true, force: true });
});

test('checkShimsExist: ok when both shims present and executable', () => {
  const home = mkdtempSync(join(tmpdir(), 'health-shims-'));
  mkdirSync(join(home, '.local/bin'), { recursive: true });
  for (const s of ['ll-watch', 'll-search']) {
    writeFileSync(join(home, '.local/bin', s), '#!/usr/bin/env bash\n');
    chmodSync(join(home, '.local/bin', s), 0o755);
  }
  const result = checkShimsExist({ home });
  assert.equal(result.status, 'ok');
  rmSync(home, { recursive: true, force: true });
});

test('checkShimsExist: fail when one shim missing', () => {
  const home = mkdtempSync(join(tmpdir(), 'health-shims-half-'));
  mkdirSync(join(home, '.local/bin'), { recursive: true });
  writeFileSync(join(home, '.local/bin/ll-search'), '#!/usr/bin/env bash\n');
  chmodSync(join(home, '.local/bin/ll-search'), 0o755);
  const result = checkShimsExist({ home });
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /ll-watch/);
  rmSync(home, { recursive: true, force: true });
});

test('checkLocalBinOnPath: ok when ~/.local/bin in PATH', () => {
  const result = checkLocalBinOnPath({
    home: '/home/test',
    pathEnv: '/usr/bin:/home/test/.local/bin:/bin',
  });
  assert.equal(result.status, 'ok');
});

test('checkLocalBinOnPath: warn when missing', () => {
  const result = checkLocalBinOnPath({
    home: '/home/test',
    pathEnv: '/usr/bin:/bin',
  });
  assert.equal(result.status, 'fail');
  assert.equal(result.severity, 'warn');
});

test('checkClaudemdSectionPresent: warn when ~/.claude/CLAUDE.md missing', () => {
  const home = mkdtempSync(join(tmpdir(), 'health-claudemd-1-'));
  const result = checkClaudemdSectionPresent({ home });
  assert.equal(result.status, 'fail');
  assert.equal(result.severity, 'warn');
  rmSync(home, { recursive: true, force: true });
});

test('checkClaudemdSectionPresent: ok when marker present', () => {
  const home = mkdtempSync(join(tmpdir(), 'health-claudemd-2-'));
  mkdirSync(join(home, '.claude'));
  writeFileSync(join(home, '.claude/CLAUDE.md'), 'other content\n<!-- learning-loop v1 -->\nbody\n<!-- /learning-loop -->\n');
  const result = checkClaudemdSectionPresent({ home });
  assert.equal(result.status, 'ok');
  rmSync(home, { recursive: true, force: true });
});

test('checkClaudemdSectionCurrent: ok when versions match', () => {
  const home = mkdtempSync(join(tmpdir(), 'health-claudemd-3-'));
  mkdirSync(join(home, '.claude'));
  writeFileSync(join(home, '.claude/CLAUDE.md'), '<!-- learning-loop v2 -->\n');
  const result = checkClaudemdSectionCurrent({ home, templateVersion: '2' });
  assert.equal(result.status, 'ok');
  rmSync(home, { recursive: true, force: true });
});

test('checkClaudemdSectionCurrent: warn when installed older than template', () => {
  const home = mkdtempSync(join(tmpdir(), 'health-claudemd-4-'));
  mkdirSync(join(home, '.claude'));
  writeFileSync(join(home, '.claude/CLAUDE.md'), '<!-- learning-loop v1 -->\n');
  const result = checkClaudemdSectionCurrent({ home, templateVersion: '2' });
  assert.equal(result.status, 'fail');
  assert.equal(result.severity, 'warn');
  rmSync(home, { recursive: true, force: true });
});

test('checkInstalledPluginsReadable: ok when JSON parses', () => {
  const home = mkdtempSync(join(tmpdir(), 'health-installed-'));
  mkdirSync(join(home, '.claude/plugins'), { recursive: true });
  writeFileSync(join(home, '.claude/plugins/installed_plugins.json'), '{"plugins": {}}');
  const result = checkInstalledPluginsReadable({ home });
  assert.equal(result.status, 'ok');
  rmSync(home, { recursive: true, force: true });
});

test('checkInstalledPluginsReadable: fail on bad JSON', () => {
  const home = mkdtempSync(join(tmpdir(), 'health-installed-bad-'));
  mkdirSync(join(home, '.claude/plugins'), { recursive: true });
  writeFileSync(join(home, '.claude/plugins/installed_plugins.json'), 'not json');
  const result = checkInstalledPluginsReadable({ home });
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /parse/i);
  rmSync(home, { recursive: true, force: true });
});

test('checkPluginCacheVersionPresent: ok when version dir exists', () => {
  const home = mkdtempSync(join(tmpdir(), 'health-cache-'));
  const verDir = join(home, '.claude/plugins/cache/learning-loop-marketplace/learning-loop/1.22.0');
  mkdirSync(verDir, { recursive: true });
  const result = checkPluginCacheVersionPresent({ home, installedVersion: '1.22.0' });
  assert.equal(result.status, 'ok');
  rmSync(home, { recursive: true, force: true });
});

test('checkPluginCacheVersionPresent: fail when version dir missing', () => {
  const home = mkdtempSync(join(tmpdir(), 'health-cache-miss-'));
  const result = checkPluginCacheVersionPresent({ home, installedVersion: '1.22.0' });
  assert.equal(result.status, 'fail');
  rmSync(home, { recursive: true, force: true });
});

test('checkSearchIndexExists: warn when missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-search-'));
  const result = checkSearchIndexExists({ vaultRoot: dir });
  assert.equal(result.status, 'fail');
  assert.equal(result.severity, 'warn');
  rmSync(dir, { recursive: true, force: true });
});

test('checkSearchIndexExists: ok when index non-empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-search-ok-'));
  mkdirSync(join(dir, '.vault-search'));
  writeFileSync(join(dir, '.vault-search/vault-index.db'), 'SQLite stub bytes...');
  const result = checkSearchIndexExists({ vaultRoot: dir });
  assert.equal(result.status, 'ok');
  rmSync(dir, { recursive: true, force: true });
});

test('checkNliSocketFresh: ok when socket missing (NLI just not running)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-nli-'));
  const result = checkNliSocketFresh({ pluginData: dir });
  assert.equal(result.status, 'ok');
  rmSync(dir, { recursive: true, force: true });
});

test('checkNliSocketFresh: warn when path exists but is not a socket', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-nli-stale-'));
  writeFileSync(join(dir, 'nli.sock'), 'not a socket');
  const result = checkNliSocketFresh({ pluginData: dir });
  assert.equal(result.status, 'fail');
  assert.equal(result.severity, 'warn');
  rmSync(dir, { recursive: true, force: true });
});

test('checkAbiDrift: ok when detectAbiDrift reports ok', () => {
  const result = checkAbiDrift({ abiDriftResult: { status: 'ok' } });
  assert.equal(result.status, 'ok');
});

test('checkAbiDrift: fail on abi-mismatch', () => {
  const result = checkAbiDrift({
    abiDriftResult: { status: 'abi-mismatch', expectedAbi: '127', actualAbi: '141', fix: 'npm rebuild' },
  });
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /127.*141/);
  assert.equal(result.fix, 'npm rebuild');
});
