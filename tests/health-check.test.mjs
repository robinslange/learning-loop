import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { skipOnWindows } from './helpers/platform.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHECK_IDS, SEVERITIES, makeCheck } from '../plugin/scripts/lib/health-checks/types.mjs';
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
  checkDuplicateGateHealth,
  checkHookErrors,
  checkInjectionShadowGate,
  checkAbiDrift,
  recentUtcMonths,
} from '../plugin/scripts/lib/health-checks/quick.mjs';
import {
  checkNodeVersion,
  checkClaudeVersion,
  checkPluginInstalled,
  checkBinaryRuns,
  checkWatchDaemon,
  checkOfflineMode,
} from '../plugin/scripts/lib/health-checks/full.mjs';
import {
  readHealthCache,
  writeHealthCache,
  isCacheStale,
  CACHE_TTL_MS,
} from '../plugin/scripts/lib/health-checks/cache.mjs';
import { INJECTION_CALIBRATION_EPOCH } from '../plugin/scripts/lib/hook-config.mjs';

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
    'duplicate-gate-health',
    'hook-errors',
    'injection-shadow-gate',
    'abi-drift',
  ];
  const full = [
    'node-version',
    'claude-version',
    'episodic-memory-installed',
    'learning-loop-installed',
    'binary-runs',
    'watch-daemon-status',
    'offline-mode',
    'edges-backfill',
  ];
  for (const id of [...quick, ...full]) {
    assert.ok(CHECK_IDS[id] === id, `missing id: ${id}`);
  }
});

test('checkOfflineMode: ok status, ON detail when offline', () => {
  const c = checkOfflineMode({ offline: true });
  assert.equal(c.id, 'offline-mode');
  assert.equal(c.status, SEVERITIES.ok);
  assert.match(c.detail, /^ON —/);
  assert.match(c.detail, /update checks/);
  assert.equal(c.fix, null);
});

test('checkOfflineMode: ok status, off detail when not offline', () => {
  const c = checkOfflineMode({ offline: false });
  assert.equal(c.status, SEVERITIES.ok);
  assert.match(c.detail, /off/);
  assert.equal(c.fix, null);
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

test(
  'checkBinaryExists: ok when binary present and executable',
  { skip: skipOnWindows('chmod semantics: stat.mode & 0o111 always 0 on win32') },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'health-bin-'));
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin/ll-search'), '#!/usr/bin/env bash\n');
    chmodSync(join(dir, 'bin/ll-search'), 0o755);
    const result = checkBinaryExists({ pluginData: dir });
    assert.equal(result.status, 'ok');
    rmSync(dir, { recursive: true, force: true });
  },
);

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

// /doctor must see a stuck binary auto-update: .version readable but lagging
// the running plugin version (the v1.20.2-for-five-releases failure shape).
test('checkBinaryVersionFile: warn when binary version is behind the plugin version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-binver-lag-'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin/.version'), 'v1.20.2\n');
  const result = checkBinaryVersionFile({ pluginData: dir, pluginVersion: '1.25.0' });
  assert.equal(result.status, 'fail');
  assert.equal(result.severity, 'warn');
  assert.match(result.detail, /v1\.20\.2 behind plugin v1\.25\.0/);
  assert.match(result.fix, /download-binary/);
  rmSync(dir, { recursive: true, force: true });
});

test('checkBinaryVersionFile: ok when binary version matches the plugin version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-binver-match-'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin/.version'), 'v1.25.0\n');
  const result = checkBinaryVersionFile({ pluginData: dir, pluginVersion: '1.25.0' });
  assert.equal(result.status, 'ok');
  rmSync(dir, { recursive: true, force: true });
});

test('checkBinaryVersionFile: ok when no pluginVersion is supplied (no comparison possible)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-binver-nover-'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin/.version'), 'v1.20.2\n');
  const result = checkBinaryVersionFile({ pluginData: dir });
  assert.equal(result.status, 'ok');
  rmSync(dir, { recursive: true, force: true });
});

test(
  'checkShimsExist: ok when both shims present and executable',
  { skip: skipOnWindows('chmod semantics: stat.mode & 0o111 always 0 on win32') },
  () => {
    const home = mkdtempSync(join(tmpdir(), 'health-shims-'));
    mkdirSync(join(home, '.local/bin'), { recursive: true });
    for (const s of ['ll-watch', 'll-search']) {
      writeFileSync(join(home, '.local/bin', s), '#!/usr/bin/env bash\n');
      chmodSync(join(home, '.local/bin', s), 0o755);
    }
    const result = checkShimsExist({ home });
    assert.equal(result.status, 'ok');
    rmSync(home, { recursive: true, force: true });
  },
);

test(
  'checkShimsExist: fail when one shim missing',
  { skip: skipOnWindows('chmod semantics: stat.mode & 0o111 always 0 on win32') },
  () => {
    const home = mkdtempSync(join(tmpdir(), 'health-shims-half-'));
    mkdirSync(join(home, '.local/bin'), { recursive: true });
    writeFileSync(join(home, '.local/bin/ll-search'), '#!/usr/bin/env bash\n');
    chmodSync(join(home, '.local/bin/ll-search'), 0o755);
    const result = checkShimsExist({ home });
    assert.equal(result.status, 'fail');
    assert.match(result.detail, /ll-watch/);
    rmSync(home, { recursive: true, force: true });
  },
);

// Windows checks: the native binary is `ll-search.exe` and the shims are
// `.cmd`, and Node statSync reports no POSIX exec bit for either. These mock
// process.platform so the win32 branches run on the (POSIX) CI runner too.
test('checkBinaryExists: ok on win32 when ll-search.exe present (no POSIX exec bit)', () => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const dir = mkdtempSync(join(tmpdir(), 'health-bin-win-'));
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin/ll-search.exe'), 'MZ');
    const result = checkBinaryExists({ pluginData: dir });
    assert.equal(result.status, 'ok');
    assert.match(result.detail, /ll-search\.exe$/);
    rmSync(dir, { recursive: true, force: true });
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
});

test('checkShimsExist: ok on win32 when .cmd shims present (no POSIX exec bit)', () => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const home = mkdtempSync(join(tmpdir(), 'health-shims-win-'));
    mkdirSync(join(home, '.local/bin'), { recursive: true });
    for (const s of ['ll-watch.cmd', 'll-search.cmd']) {
      writeFileSync(join(home, '.local/bin', s), '@echo off\n');
    }
    const result = checkShimsExist({ home });
    assert.equal(result.status, 'ok');
    rmSync(home, { recursive: true, force: true });
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
});

test('checkShimsExist: fail on win32 when only extensionless shims exist', () => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const home = mkdtempSync(join(tmpdir(), 'health-shims-win-noext-'));
    mkdirSync(join(home, '.local/bin'), { recursive: true });
    for (const s of ['ll-watch', 'll-search']) {
      writeFileSync(join(home, '.local/bin', s), '#!/usr/bin/env bash\n');
    }
    const result = checkShimsExist({ home });
    assert.equal(result.status, 'fail');
    assert.match(result.detail, /ll-watch/);
    rmSync(home, { recursive: true, force: true });
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
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
  writeFileSync(
    join(home, '.claude/CLAUDE.md'),
    'other content\n<!-- learning-loop v1 -->\nbody\n<!-- /learning-loop -->\n',
  );
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

test('checkDuplicateGateHealth: ok when no hook-errors log present', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-dupgate-'));
  const result = checkDuplicateGateHealth({ pluginData: dir });
  assert.equal(result.status, 'ok');
  assert.match(result.detail, /no recent timeouts/);
  rmSync(dir, { recursive: true, force: true });
});

test('checkDuplicateGateHealth: warns on repeated duplicate-gate timeouts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-dupgate-warn-'));
  const now = new Date('2026-06-12T00:00:00Z');
  const month = now.toISOString().slice(0, 7);
  const lines = [];
  for (let i = 0; i < 4; i++) {
    lines.push(
      JSON.stringify({
        ts: now.toISOString(),
        module: 'pre-write-check.checkDuplicateNote',
        code: 'duplicate-gate-timeout',
        source: 'subprocess',
        message: 'ETIMEDOUT',
      }),
    );
  }
  // An unrelated error line must not be counted.
  lines.push(JSON.stringify({ ts: now.toISOString(), module: 'other', message: 'boom' }));
  writeFileSync(join(dir, `hook-errors-${month}.jsonl`), lines.join('\n') + '\n');

  const result = checkDuplicateGateHealth({ pluginData: dir, now });
  assert.equal(result.status, 'fail');
  assert.equal(result.severity, 'warn');
  assert.match(result.detail, /4 duplicate-gate timeouts/);
  assert.match(result.fix, /ll-watch/);
  rmSync(dir, { recursive: true, force: true });
});

test('checkDuplicateGateHealth: stays ok under the repeat threshold', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-dupgate-under-'));
  const now = new Date('2026-06-12T00:00:00Z');
  const month = now.toISOString().slice(0, 7);
  writeFileSync(
    join(dir, `hook-errors-${month}.jsonl`),
    JSON.stringify({ code: 'duplicate-gate-timeout', source: 'daemon' }) + '\n',
  );
  const result = checkDuplicateGateHealth({ pluginData: dir, now });
  assert.equal(result.status, 'ok');
  assert.match(result.detail, /under threshold/);
  rmSync(dir, { recursive: true, force: true });
});

test('checkDuplicateGateHealth: warns on stale-daemon error code with restart advice', () => {
  // A single stale-daemon entry triggers a distinct warning with restart advice,
  // not the generic ll-watch start advice.
  const dir = mkdtempSync(join(tmpdir(), 'health-dupgate-stale-'));
  const now = new Date('2026-06-12T00:00:00Z');
  const month = now.toISOString().slice(0, 7);
  writeFileSync(
    join(dir, `hook-errors-${month}.jsonl`),
    JSON.stringify({
      code: 'duplicate-gate-stale-daemon',
      source: 'daemon',
      message: 'parse request: ...',
    }) + '\n',
  );
  const result = checkDuplicateGateHealth({ pluginData: dir, now });
  assert.equal(result.status, 'fail');
  assert.equal(result.severity, 'warn');
  assert.match(result.detail, /stale daemon/i);
  assert.match(result.fix, /restart/i);
  rmSync(dir, { recursive: true, force: true });
});

test('checkDuplicateGateHealth: previous-month UTC arithmetic (regression for UTC+ timezone bug)', () => {
  // In NZ (UTC+13), local midnight on 2026-06-01 is 2026-05-31T11:00Z,
  // so `new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString()`
  // would produce '2026-04-...' instead of '2026-05'. recentUtcMonths must
  // use UTC arithmetic.
  // Place timeout entries in the PREVIOUS UTC month's file. With a `now`
  // near the start of June UTC (but June 1 local in UTC+13), the previous
  // UTC month is May. A local-time implementation would scan April instead.
  const dir = mkdtempSync(join(tmpdir(), 'health-dupgate-utc-'));
  // now = 2026-06-01T05:00:00Z — still May 31 in UTC-... no, we want UTC+13.
  // Use 2026-06-01T00:30:00Z — this is 2026-06-01T13:30 NZST (UTC+13:00),
  // so local midnight check of getMonth()-1 would land on April not May.
  const now = new Date('2026-06-01T00:30:00Z');
  const prevUtcMonth = '2026-05';
  // Write 4 timeouts in the previous UTC month file.
  const lines = Array(4)
    .fill(null)
    .map(() => JSON.stringify({ code: 'duplicate-gate-timeout', source: 'daemon' }));
  writeFileSync(join(dir, `hook-errors-${prevUtcMonth}.jsonl`), lines.join('\n') + '\n');
  const result = checkDuplicateGateHealth({ pluginData: dir, now });
  assert.equal(result.status, 'fail', 'must scan previous UTC month, not local-time month-2');
  assert.match(result.detail, /4 duplicate-gate timeouts/);
  rmSync(dir, { recursive: true, force: true });
});

test('recentUtcMonths: returns UTC YYYY-MM for current and previous month', () => {
  // Verify the helper itself produces correct UTC strings for a UTC+ edge case.
  const now = new Date('2026-06-01T00:30:00Z');
  const months = recentUtcMonths(now);
  assert.deepEqual(months, ['2026-06', '2026-05']);
});

test('recentUtcMonths: wraps year boundary correctly (Jan -> prev Dec)', () => {
  const now = new Date('2026-01-15T00:00:00Z');
  const months = recentUtcMonths(now);
  assert.deepEqual(months, ['2026-01', '2025-12']);
});

// --- checkHookErrors ---

test('checkHookErrors: ok when no hook-errors log present', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-hookerr-'));
  const result = checkHookErrors({ pluginData: dir });
  assert.equal(result.status, 'ok');
  assert.match(result.detail, /no hook errors logged/);
  rmSync(dir, { recursive: true, force: true });
});

test('checkHookErrors: ok with no pluginData (skipped)', () => {
  const result = checkHookErrors({});
  assert.equal(result.status, 'ok');
  assert.match(result.detail, /skipped/);
});

test('checkHookErrors: warns when error count exceeds threshold', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-hookerr-warn-'));
  const now = new Date('2026-06-12T00:00:00Z');
  const month = now.toISOString().slice(0, 7);
  const lines = [];
  for (let i = 0; i < 6; i++) {
    lines.push(
      JSON.stringify({
        ts: `2026-06-12T0${i}:00:00.000Z`,
        module: `mod-${i}`,
        message: `error message ${i}`,
      }),
    );
  }
  // A corrupt line must not throw or count.
  lines.push('not-json{{{');
  writeFileSync(join(dir, `hook-errors-${month}.jsonl`), lines.join('\n') + '\n');

  const result = checkHookErrors({ pluginData: dir, now });
  assert.equal(result.status, 'fail');
  assert.equal(result.severity, 'warn');
  assert.match(result.detail, /6 hook errors/);
  // Latest ts wins — last entry is i=5 (ts 05:00)
  assert.match(result.detail, /mod-5/);
  assert.match(result.detail, /error message 5/);
  assert.match(result.fix, /hook-errors/);
  rmSync(dir, { recursive: true, force: true });
});

test('checkHookErrors: ok when count is at or under threshold', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-hookerr-under-'));
  const now = new Date('2026-06-12T00:00:00Z');
  const month = now.toISOString().slice(0, 7);
  const lines = Array(5)
    .fill(null)
    .map((_, i) =>
      JSON.stringify({ ts: `2026-06-12T0${i}:00:00.000Z`, module: 'x', message: 'err' }),
    );
  writeFileSync(join(dir, `hook-errors-${month}.jsonl`), lines.join('\n') + '\n');
  const result = checkHookErrors({ pluginData: dir, now });
  assert.equal(result.status, 'ok');
  assert.match(result.detail, /under threshold/);
  rmSync(dir, { recursive: true, force: true });
});

test('checkHookErrors: counts across current and previous UTC month', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-hookerr-months-'));
  const now = new Date('2026-06-01T00:30:00Z');
  const curMonth = '2026-06';
  const prevMonth = '2026-05';
  // 3 in current month + 3 in previous = 6 total (> threshold of 5)
  const makeLines = (month, count) =>
    Array(count)
      .fill(null)
      .map((_, i) =>
        JSON.stringify({ ts: `${month}-10T0${i}:00:00.000Z`, module: 'mod', message: 'err' }),
      )
      .join('\n') + '\n';
  writeFileSync(join(dir, `hook-errors-${curMonth}.jsonl`), makeLines(curMonth, 3));
  writeFileSync(join(dir, `hook-errors-${prevMonth}.jsonl`), makeLines(prevMonth, 3));
  const result = checkHookErrors({ pluginData: dir, now });
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /6 hook errors/);
  rmSync(dir, { recursive: true, force: true });
});

test('checkHookErrors: ts-less first line is displaced by later line with ts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-hookerr-tsless-'));
  const now = new Date('2026-06-12T00:00:00Z');
  const month = now.toISOString().slice(0, 7);
  const lines = [];
  // First line has no ts — must not become the permanent "latest"
  lines.push(JSON.stringify({ module: 'ts-less-module', message: 'ts-less error' }));
  // Subsequent lines have ts and should displace the ts-less line
  for (let i = 1; i <= 5; i++) {
    lines.push(
      JSON.stringify({
        ts: `2026-06-12T0${i}:00:00.000Z`,
        module: `real-module-${i}`,
        message: `real error ${i}`,
      }),
    );
  }
  writeFileSync(join(dir, `hook-errors-${month}.jsonl`), lines.join('\n') + '\n');

  const result = checkHookErrors({ pluginData: dir, now });
  assert.equal(result.status, 'fail');
  // The ts-bearing latest (i=5, ts 05:00) must appear in detail, not the ts-less first line
  assert.match(result.detail, /real-module-5/);
  assert.doesNotMatch(result.detail, /ts-less-module/);
  rmSync(dir, { recursive: true, force: true });
});

// --- checkInjectionShadowGate ---

function writeShadowLog(dir, month, entries) {
  mkdirSync(join(dir, 'retrieval'), { recursive: true });
  writeFileSync(
    join(dir, 'retrieval', `shadow-injection-${month}.jsonl`),
    entries.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n',
  );
}

// Fixtures must sit after the calibration epoch or the epoch filter drops them
// and every assertion below collapses to "0/0 entries — keep collecting".
// Derived from the constant rather than hardcoded: the epoch moves whenever the
// threshold or the fusion scale changes, and a pinned literal silently rots the
// moment it does (it did, on the 2026-08-04 weighted-fusion rescale).
const POST_EPOCH_TS = new Date(
  Date.parse(INJECTION_CALIBRATION_EPOCH) + 60 * 60 * 1000,
).toISOString();
const POST_EPOCH_MONTH = POST_EPOCH_TS.slice(0, 7);
const POST_EPOCH_NOW = new Date(Date.parse(INJECTION_CALIBRATION_EPOCH) + 2 * 60 * 60 * 1000);
// The month before POST_EPOCH_MONTH, for the two-month rollup test.
const POST_EPOCH_PREV_MONTH = new Date(
  Date.UTC(POST_EPOCH_NOW.getUTCFullYear(), POST_EPOCH_NOW.getUTCMonth() - 1, 1),
)
  .toISOString()
  .slice(0, 7);
// Strictly before the epoch, so the filter must drop it.
const PRE_EPOCH_TS = new Date(Date.parse(INJECTION_CALIBRATION_EPOCH) - 1000).toISOString();
const shadowPass = {
  ts: POST_EPOCH_TS,
  gate: { passed: true, vault_top_score: 0.42 },
  backends: {},
};
const shadowFail = {
  ts: POST_EPOCH_TS,
  gate: { passed: false, vault_top_score: 0.1 },
  backends: {},
};
const shadowFastPath = { ts: POST_EPOCH_TS, gate: { passed: false, fast_path_skip: true } };
const shadowVaultError = {
  ts: POST_EPOCH_TS,
  gate: { passed: false },
  backends: { vault: { error: 'spawn ENOENT' } },
};

test('checkInjectionShadowGate: ok when injection_mode is live', () => {
  const result = checkInjectionShadowGate({ pluginData: '/nonexistent', injectionMode: 'live' });
  assert.equal(result.status, 'ok');
  assert.match(result.detail, /live/);
});

test('checkInjectionShadowGate: ok when injection_mode is off', () => {
  const result = checkInjectionShadowGate({ pluginData: '/nonexistent', injectionMode: 'off' });
  assert.equal(result.status, 'ok');
  assert.match(result.detail, /off/);
});

test('checkInjectionShadowGate: ok-skipped without plugin-data', () => {
  const result = checkInjectionShadowGate({ pluginData: null, injectionMode: 'shadow' });
  assert.equal(result.status, 'ok');
  assert.match(result.detail, /skipped/);
});

test('checkInjectionShadowGate: shadow mode with no logs stays ok (keep collecting)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-shadowgate-empty-'));
  const result = checkInjectionShadowGate({ pluginData: dir, injectionMode: 'shadow' });
  assert.equal(result.status, 'ok');
  assert.match(result.detail, /keep collecting/);
  rmSync(dir, { recursive: true, force: true });
});

test('checkInjectionShadowGate: nudges ready-for-review when the go-live gate passes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-shadowgate-ready-'));
  const now = POST_EPOCH_NOW;
  const entries = [];
  for (let i = 0; i < 25; i++) entries.push(shadowPass);
  for (let i = 0; i < 80; i++) entries.push(shadowFail);
  writeShadowLog(dir, POST_EPOCH_MONTH, entries);
  const result = checkInjectionShadowGate({ pluginData: dir, injectionMode: 'shadow', now });
  assert.equal(result.status, 'fail');
  assert.equal(result.severity, 'warn');
  assert.match(result.detail, /ready for review/);
  assert.match(result.detail, /25\/105/);
  assert.match(result.fix, /doctor/);
  assert.match(result.fix, /review-shadow/);
  rmSync(dir, { recursive: true, force: true });
});

test('checkInjectionShadowGate: stays ok below the healthy-entry minimum', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-shadowgate-thin-'));
  const now = POST_EPOCH_NOW;
  writeShadowLog(dir, POST_EPOCH_MONTH, Array(50).fill(shadowPass));
  const result = checkInjectionShadowGate({ pluginData: dir, injectionMode: 'shadow', now });
  assert.equal(result.status, 'ok');
  assert.match(result.detail, /keep collecting/);
  rmSync(dir, { recursive: true, force: true });
});

test('checkInjectionShadowGate: stays ok below the pass minimum', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-shadowgate-fewpass-'));
  const now = POST_EPOCH_NOW;
  writeShadowLog(dir, POST_EPOCH_MONTH, [...Array(10).fill(shadowPass), ...Array(150).fill(shadowFail)]);
  const result = checkInjectionShadowGate({ pluginData: dir, injectionMode: 'shadow', now });
  assert.equal(result.status, 'ok');
  rmSync(dir, { recursive: true, force: true });
});

test('checkInjectionShadowGate: infrastructure warning when backend health below 60%', () => {
  // 500 vault-error entries out of 1105 total puts backend health at ~55%,
  // squarely in review-shadow.mjs's INFRASTRUCTURE regime. The check must report
  // infrastructure warning rather than ready-to-flip — pass rates over surviving
  // entries aren't evidence about the gate when >40% of entries errored.
  const dir = mkdtempSync(join(tmpdir(), 'health-shadowgate-infra-'));
  const now = POST_EPOCH_NOW;
  const entries = [
    ...Array(25).fill(shadowPass),
    ...Array(80).fill(shadowFail),
    ...Array(500).fill(shadowFastPath),
    ...Array(500).fill(shadowVaultError),
    '{not json',
  ];
  writeShadowLog(dir, POST_EPOCH_MONTH, entries);
  const result = checkInjectionShadowGate({ pluginData: dir, injectionMode: 'shadow', now });
  assert.equal(result.status, 'ok', 'infrastructure problem must not emit the ready-to-flip nudge');
  assert.match(result.detail, /infrastructure/i);
  assert.match(result.detail, /review-shadow/);
  rmSync(dir, { recursive: true, force: true });
});

test('checkInjectionShadowGate: fast-path skips and corrupt lines are excluded from healthy count', () => {
  // Fast-path skips and corrupt lines must not count as healthy entries.
  // With 100 vault-ok entries (25 pass + 75 fail) and no backend errors,
  // the gate should see the clean 25/100 and report ready-to-flip.
  const dir = mkdtempSync(join(tmpdir(), 'health-shadowgate-noise-'));
  const now = POST_EPOCH_NOW;
  const entries = [
    ...Array(25).fill(shadowPass),
    ...Array(75).fill(shadowFail),
    ...Array(10).fill(shadowFastPath),
    '{not json',
  ];
  writeShadowLog(dir, POST_EPOCH_MONTH, entries);
  const result = checkInjectionShadowGate({ pluginData: dir, injectionMode: 'shadow', now });
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /25\/100/);
  rmSync(dir, { recursive: true, force: true });
});

test('checkInjectionShadowGate: combines current and previous month logs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-shadowgate-months-'));
  const now = POST_EPOCH_NOW;
  writeShadowLog(dir, POST_EPOCH_MONTH, [...Array(15).fill(shadowPass), ...Array(40).fill(shadowFail)]);
  writeShadowLog(dir, POST_EPOCH_PREV_MONTH, [...Array(10).fill(shadowPass), ...Array(40).fill(shadowFail)]);
  // 25 passes over 105 healthy entries across the two months.
  const result = checkInjectionShadowGate({ pluginData: dir, injectionMode: 'shadow', now });
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /25\/105/);
  rmSync(dir, { recursive: true, force: true });
});

test('checkInjectionShadowGate: snooze dismissed silences the nag when gate-ready', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-shadowgate-snooze-'));
  const now = POST_EPOCH_NOW;
  const entries = [...Array(25).fill(shadowPass), ...Array(80).fill(shadowFail)];
  writeShadowLog(dir, POST_EPOCH_MONTH, entries);
  // Gate-ready but nudge dismissed — should not emit the ready-for-review fail.
  const result = checkInjectionShadowGate({
    pluginData: dir,
    injectionMode: 'shadow',
    injectionNudge: 'dismissed',
    now,
  });
  assert.equal(result.status, 'ok', 'dismissed nudge must silence the ready-for-review fail');
  assert.match(result.detail, /dismissed/);
  rmSync(dir, { recursive: true, force: true });
});

test('checkInjectionShadowGate: pre-epoch entries are filtered out', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-shadowgate-epoch-'));
  const now = POST_EPOCH_NOW;
  // Pre-epoch entries should not count toward the gate criteria.
  const preEpochTs = PRE_EPOCH_TS;
  const stalePass = { ts: preEpochTs, gate: { passed: true, vault_top_score: 0.42 }, backends: {} };
  const staleFail = { ts: preEpochTs, gate: { passed: false, vault_top_score: 0.1 }, backends: {} };
  const entries = [...Array(200).fill(stalePass), ...Array(100).fill(staleFail)];
  writeShadowLog(dir, POST_EPOCH_MONTH, entries);
  const result = checkInjectionShadowGate({ pluginData: dir, injectionMode: 'shadow', now });
  // All 300 entries predate the epoch — gate sees 0 post-epoch healthy entries.
  assert.equal(result.status, 'ok');
  assert.match(result.detail, /keep collecting/);
  rmSync(dir, { recursive: true, force: true });
});

test('checkAbiDrift: ok when detectAbiDrift reports ok', () => {
  const result = checkAbiDrift({ abiDriftResult: { status: 'ok' } });
  assert.equal(result.status, 'ok');
});

test('checkAbiDrift: fail on abi-mismatch', () => {
  const result = checkAbiDrift({
    abiDriftResult: {
      status: 'abi-mismatch',
      expectedAbi: '127',
      actualAbi: '141',
      fix: 'npm rebuild',
    },
  });
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /127.*141/);
  assert.equal(result.fix, 'npm rebuild');
});

test('checkNodeVersion: ok when major >= 22', () => {
  const result = checkNodeVersion({ nodeVersionOutput: 'v25.9.0', minMajor: 22 });
  assert.equal(result.status, 'ok');
});

test('checkNodeVersion: fail when major < 22', () => {
  const result = checkNodeVersion({ nodeVersionOutput: 'v18.0.0', minMajor: 22 });
  assert.equal(result.status, 'fail');
  assert.match(result.fix, /22/);
});

test('checkNodeVersion: fail when node not found', () => {
  const result = checkNodeVersion({ nodeVersionOutput: null, minMajor: 22 });
  assert.equal(result.status, 'fail');
});

test('checkClaudeVersion: ok when version >= min', () => {
  const result = checkClaudeVersion({
    claudeVersionOutput: '2.1.145 (Claude Code)',
    minVersion: '2.1.144',
  });
  assert.equal(result.status, 'ok');
});

test('checkClaudeVersion: fail when too old', () => {
  const result = checkClaudeVersion({ claudeVersionOutput: '2.0.0', minVersion: '2.1.144' });
  assert.equal(result.status, 'fail');
});

test('checkPluginInstalled: ok when present in registry', () => {
  const result = checkPluginInstalled({
    pluginName: 'episodic-memory',
    marketplace: 'superpowers-marketplace',
    installedPlugins: {
      'episodic-memory@superpowers-marketplace': [{ version: '1.0.15' }],
    },
    severity: 'fail',
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.detail, '1.0.15');
});

test('checkPluginInstalled: fail when missing', () => {
  const result = checkPluginInstalled({
    pluginName: 'episodic-memory',
    marketplace: 'superpowers-marketplace',
    installedPlugins: {},
    severity: 'fail',
  });
  assert.equal(result.status, 'fail');
  assert.equal(result.severity, 'fail');
  assert.match(result.fix, /plugin install/);
});

test('checkBinaryRuns: ok when version output looks valid', () => {
  const result = checkBinaryRuns({ binaryVersionOutput: 'll-search 1.4.0', exitCode: 0 });
  assert.equal(result.status, 'ok');
});

test('checkBinaryRuns: fail when binary errors', () => {
  const result = checkBinaryRuns({ binaryVersionOutput: null, exitCode: 127 });
  assert.equal(result.status, 'fail');
});

test('checkWatchDaemon: ok when pidfile absent', () => {
  const result = checkWatchDaemon({ pidfileExists: false });
  assert.equal(result.status, 'ok');
  assert.match(result.detail, /not running/i);
});

test('checkWatchDaemon: ok when pid alive', () => {
  const result = checkWatchDaemon({ pidfileExists: true, pidIsAlive: true, pid: 1234 });
  assert.equal(result.status, 'ok');
});

test('checkWatchDaemon: warn when stale pidfile', () => {
  const result = checkWatchDaemon({ pidfileExists: true, pidIsAlive: false, pid: 9999 });
  assert.equal(result.status, 'fail');
  assert.equal(result.severity, 'warn');
});

test('CACHE_TTL_MS is 12 hours', () => {
  assert.equal(CACHE_TTL_MS, 12 * 60 * 60 * 1000);
});

test('readHealthCache returns null when file missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-cache-1-'));
  const result = readHealthCache({ pluginData: dir });
  assert.equal(result, null);
  rmSync(dir, { recursive: true, force: true });
});

test('writeHealthCache + readHealthCache round-trip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-cache-2-'));
  const payload = {
    ts: '2026-05-21T01:30:00.000Z',
    ran: 'full',
    checks: [{ id: 'vault-path', status: 'ok', severity: 'fail', detail: '/v', fix: null }],
  };
  writeHealthCache({ pluginData: dir, result: payload });
  const back = readHealthCache({ pluginData: dir });
  assert.deepEqual(back, payload);
  rmSync(dir, { recursive: true, force: true });
});

test('isCacheStale: false when ts is recent', () => {
  const recent = new Date(Date.now() - 60 * 1000).toISOString();
  assert.equal(isCacheStale({ ts: recent }), false);
});

test('isCacheStale: true when ts > 12h old', () => {
  const old = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString();
  assert.equal(isCacheStale({ ts: old }), true);
});

test('isCacheStale: true when cache is null', () => {
  assert.equal(isCacheStale(null), true);
});

test('readHealthCache returns null on corrupt JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-cache-3-'));
  writeFileSync(join(dir, 'last-health.json'), '{not json');
  const result = readHealthCache({ pluginData: dir });
  assert.equal(result, null);
  rmSync(dir, { recursive: true, force: true });
});

import { runQuickChecks, formatMissingDeps } from '../plugin/scripts/health-check.mjs';

test('runQuickChecks: returns ran=quick + non-empty checks array', async () => {
  const result = await runQuickChecks({
    pluginData: '/nonexistent',
    vaultRoot: null,
    home: '/nonexistent',
    pathEnv: '',
    installedVersion: '0.0.0',
    templateVersion: '1',
    abiDriftResult: { status: 'ok' },
  });
  assert.equal(result.ran, 'quick');
  assert.ok(Array.isArray(result.checks));
  assert.ok(result.checks.length >= 10);
  assert.ok(result.checks.every((c) => typeof c.id === 'string'));
});

test('runQuickChecks: includes ts in ISO-8601 format', async () => {
  const result = await runQuickChecks({
    pluginData: '/x',
    vaultRoot: null,
    home: '/x',
    pathEnv: '',
    installedVersion: '0.0.0',
    templateVersion: '1',
    abiDriftResult: { status: 'ok' },
  });
  assert.match(result.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});

test('formatMissingDeps: empty input returns empty string', () => {
  assert.equal(formatMissingDeps({ checks: [] }), '');
});

test('formatMissingDeps: required failures render with required heading', () => {
  const result = {
    checks: [
      {
        id: 'episodic-memory-installed',
        name: 'episodic-memory plugin',
        status: 'fail',
        severity: 'fail',
        detail: 'not installed',
        fix: 'claude plugin install episodic-memory@superpowers-marketplace',
      },
    ],
  };
  const md = formatMissingDeps(result);
  assert.match(md, /Missing Required Dependencies/);
  assert.match(md, /episodic-memory/);
  assert.match(md, /claude plugin install/);
});

test('formatMissingDeps: warn-severity issues go under optional heading', () => {
  const result = {
    checks: [
      {
        id: 'local-bin-on-path',
        name: '~/.local/bin on PATH',
        status: 'fail',
        severity: 'warn',
        detail: 'not on PATH',
        fix: 'add to your shell rc',
      },
    ],
  };
  const md = formatMissingDeps(result);
  assert.match(md, /Missing Optional Dependencies/);
});

test('formatMissingDeps: injection-shadow-gate readiness is not a missing dependency', () => {
  const result = {
    checks: [
      {
        id: 'injection-shadow-gate',
        name: 'Injection shadow gate',
        status: 'fail',
        severity: 'warn',
        detail: 'shadow gate passing — ready to flip injection_mode to live',
        fix: 'run /learning-loop:doctor',
      },
    ],
  };
  assert.equal(formatMissingDeps(result), '');
});
