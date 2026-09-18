import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { skipOnWindows } from './helpers/platform.mjs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { CHECK_IDS, SEVERITIES, makeCheck } from '../plugin/scripts/lib/health-checks/types.mjs';
import { monthStr } from '../plugin/scripts/lib/retrieval.mjs';
import { SHIM_NAMES } from '../plugin/scripts/lib/paths.mjs';
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
  checkFederationSyncHealth,
  checkHookErrors,
  checkInjectionShadowGate,
  checkAbiDrift,
  recentMonths,
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

// A sandbox home whose shims can actually resolve an install. checkShimsExist
// asserts resolvability, not just that four files exist, so a home staging only
// ~/.local/bin describes the state 2.0.7 shipped — four correct shims, every one
// of them exiting 1 — and is not what "a healthy install" looks like.
function stageResolvableRoot(home, version = '9.9.9') {
  const root = join(home, '.claude/plugins/cache/learning-loop-marketplace/learning-loop', version);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'shim.mjs'), '// stub\n');
  return root;
}

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

test('checkShimsExist: a correct Windows install is not four missing shims', () => {
  // `platform` is injected rather than skipped-on-non-Windows, because the
  // bug is invisible on the machine that finds it: the check looked for the
  // POSIX name on every platform, so a Windows box with four correctly
  // written `.cmd` shims reported all four missing and offered to reinstall
  // them, every session, forever. No test could see that from macOS or Linux.
  const home = mkdtempSync(join(tmpdir(), 'health-shims-win-'));
  mkdirSync(join(home, '.local/bin'), { recursive: true });
  for (const s of SHIM_NAMES) {
    writeFileSync(join(home, '.local/bin', `${s}.cmd`), '@echo off\r\n');
  }
  stageResolvableRoot(home);

  const result = checkShimsExist({ home, platform: 'win32' });

  assert.equal(result.status, 'ok', `detail: ${result.detail}`);
  rmSync(home, { recursive: true, force: true });
});

test('checkShimsExist: the POSIX names do not satisfy a Windows install', () => {
  // The other side. A check that passed on any file at all would satisfy the
  // test above while still not knowing what the installer writes.
  const home = mkdtempSync(join(tmpdir(), 'health-shims-win-posix-'));
  mkdirSync(join(home, '.local/bin'), { recursive: true });
  for (const s of SHIM_NAMES) writeFileSync(join(home, '.local/bin', s), '#!/bin/sh\n');

  const result = checkShimsExist({ home, platform: 'win32' });

  assert.equal(result.status, 'fail');
  assert.match(result.detail, /ll-watch\.cmd/, 'and it names the file it wanted');
  rmSync(home, { recursive: true, force: true });
});

test('checkLocalBinOnPath: splits PATH on the platform delimiter', () => {
  // On Windows every PATH entry contains a ':' of its own (the drive letter),
  // so splitting on ':' produced segments like 'C' and '\\Users\\x\\.local\\bin'
  // and matched nothing. This asserts the POSIX case still works rather than
  // only the Windows one, because `delimiter` is what makes both true and a
  // test of one direction cannot see a constant hardcoded the other way.
  const home = mkdtempSync(join(tmpdir(), 'health-path-'));
  const target = join(home, '.local', 'bin');

  const onPath = checkLocalBinOnPath({
    home,
    pathEnv: [join('/usr', 'bin'), target].join(delimiter),
  });
  assert.equal(onPath.status, 'ok', `detail: ${onPath.detail}`);

  const offPath = checkLocalBinOnPath({ home, pathEnv: join('/usr', 'bin') });
  assert.equal(offPath.status, 'fail');

  // The delimiter is INJECTED, not taken from this machine. On macOS and Linux
  // `delimiter` is ':' and a hardcoded ':' passes every assertion above — the
  // first version of this test could not fail on the platform it runs on,
  // which is the whole reason the Windows bug survived.
  const semicolonPath = [join('/usr', 'bin'), target].join(';');
  const windowsish = checkLocalBinOnPath({ home, pathEnv: semicolonPath, pathDelimiter: ';' });
  assert.equal(windowsish.status, 'ok', 'a ";"-separated PATH must split on ";"');

  const wrongDelimiter = checkLocalBinOnPath({
    home,
    pathEnv: semicolonPath,
    pathDelimiter: ':',
  });
  assert.equal(
    wrongDelimiter.status,
    'fail',
    'and splitting it on ":" must NOT find the target, or the assertion above proves nothing',
  );
  rmSync(home, { recursive: true, force: true });
});

test(
  'checkShimsExist: ok when every shim is present and executable',
  { skip: skipOnWindows('chmod semantics: stat.mode & 0o111 always 0 on win32') },
  () => {
    const home = mkdtempSync(join(tmpdir(), 'health-shims-'));
    mkdirSync(join(home, '.local/bin'), { recursive: true });
    for (const s of SHIM_NAMES) {
      writeFileSync(join(home, '.local/bin', s), '#!/usr/bin/env bash\n');
      chmodSync(join(home, '.local/bin', s), 0o755);
    }
    stageResolvableRoot(home);
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
    assert.match(result.detail, /ll-paths/);
    rmSync(home, { recursive: true, force: true });
  },
);

test(
  'checkShimsExist: fail when only ll-paths is missing',
  { skip: skipOnWindows('chmod semantics: stat.mode & 0o111 always 0 on win32') },
  () => {
    // Its own case because every Bash block outside a SKILL.md bootstraps
    // through `ll-paths`, and an install that wrote the other two would leave
    // those blocks calling a command that does not exist. A check that only
    // ever sees a wholly empty ~/.local/bin cannot tell that apart from health.
    const home = mkdtempSync(join(tmpdir(), 'health-shims-nopaths-'));
    mkdirSync(join(home, '.local/bin'), { recursive: true });
    for (const s of ['ll-watch', 'll-search']) {
      writeFileSync(join(home, '.local/bin', s), '#!/usr/bin/env bash\n');
      chmodSync(join(home, '.local/bin', s), 0o755);
    }
    const result = checkShimsExist({ home });
    assert.equal(result.status, 'fail');
    assert.match(result.detail, /ll-paths/);
    rmSync(home, { recursive: true, force: true });
  },
);

test(
  'checkShimsExist: present, executable shims that cannot resolve an install are not ready',
  { skip: skipOnWindows('chmod semantics: stat.mode & 0o111 always 0 on win32') },
  () => {
    // 2.0.7 shipped without scripts/shim.mjs, which is the file every shim
    // looks for to locate the active install. All four were present,
    // executable and byte-correct, and all four exited 1 on every invocation
    // for a whole session while this check reported them ready. This is the
    // check consulted when the shims are the broken thing, so a false ok here
    // sends the reader somewhere else entirely.
    const home = mkdtempSync(join(tmpdir(), 'health-shims-unresolvable-'));
    mkdirSync(join(home, '.local/bin'), { recursive: true });
    for (const s of SHIM_NAMES) {
      writeFileSync(join(home, '.local/bin', s), '#!/usr/bin/env bash\n');
      chmodSync(join(home, '.local/bin', s), 0o755);
    }
    // A cache root that exists but ships no scripts/shim.mjs: exactly 2.0.7.
    mkdirSync(join(home, '.claude/plugins/cache/learning-loop-marketplace/learning-loop/2.0.7'), {
      recursive: true,
    });

    const result = checkShimsExist({ home });

    assert.equal(result.status, 'fail', `detail: ${result.detail}`);
    assert.match(result.detail, /shim\.mjs/, 'and it names the file that is missing');
    assert.doesNotMatch(
      result.fix,
      /install-shims/,
      'rewriting shims that resolve to a tree with no shim.mjs reproduces the same failure',
    );
    rmSync(home, { recursive: true, force: true });
  },
);

// The native binary is `ll-search.exe` on Windows, and Node reports no POSIX
// exec bit for it. `platform` is injected for the same reason the shim tests
// inject it: the bug is invisible from the machine that finds it, because the
// check looked for the POSIX name on every platform. A Windows box with a
// correctly downloaded binary reported it missing and offered to re-download,
// every session, while `lib/binary.mjs` resolved the same file fine.
test('checkBinaryExists: a downloaded ll-search.exe is not a missing binary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-bin-win-'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin/ll-search.exe'), 'MZ');

  const result = checkBinaryExists({ pluginData: dir, platform: 'win32' });

  assert.equal(result.status, 'ok', `detail: ${result.detail}`);
  assert.match(result.detail, /ll-search\.exe$/, 'and it names the file it found');
  rmSync(dir, { recursive: true, force: true });
});

test(
  'checkBinaryExists: a present but non-executable binary still fails on POSIX',
  { skip: skipOnWindows('chmod semantics: stat.mode & 0o111 always 0 on win32') },
  () => {
    // The win32 fix put `platform !== 'win32' &&` in front of the mode test.
    // Nothing asserted the POSIX half still fires, so changing that condition
    // to `false &&` -- disabling the executability check on every platform --
    // left the whole suite green. A downloaded-but-unchmodded binary is a real
    // install state, and it is one /doctor exists to name.
    const dir = mkdtempSync(join(tmpdir(), 'health-bin-noexec-'));
    mkdirSync(join(dir, 'bin'));
    const bin = join(dir, 'bin/ll-search');
    writeFileSync(bin, '#!/usr/bin/env bash\n');
    chmodSync(bin, 0o644);

    const result = checkBinaryExists({ pluginData: dir });

    assert.equal(result.status, 'fail');
    assert.match(result.detail, /not executable/);
    assert.match(result.fix, /chmod/);
    rmSync(dir, { recursive: true, force: true });
  },
);

test('checkBinaryExists: the POSIX name does not satisfy a Windows install', () => {
  // The other side. A check that passed on any file at all would satisfy the
  // test above while still not knowing what the downloader writes.
  const dir = mkdtempSync(join(tmpdir(), 'health-bin-win-posix-'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin/ll-search'), '#!/bin/sh\n');

  const result = checkBinaryExists({ pluginData: dir, platform: 'win32' });

  assert.equal(result.status, 'fail');
  assert.match(result.detail, /ll-search\.exe$/, 'and it names the file it wanted');
  rmSync(dir, { recursive: true, force: true });
});

test('checkLocalBinOnPath: ok when ~/.local/bin in PATH', () => {
  // Built with `join` and `delimiter` rather than a POSIX string, because the
  // check compares the path the way the platform spells it and splits PATH on
  // the platform's separator. A hardcoded `/home/test/.local/bin` inside a
  // ':'-joined PATH is not an input Windows can produce, and asserting it
  // works there tests nothing about either platform.
  const home = join('/home', 'test');
  const target = join(home, '.local', 'bin');
  const result = checkLocalBinOnPath({
    home,
    pathEnv: [join('/usr', 'bin'), target, join('/bin')].join(delimiter),
  });
  assert.equal(result.status, 'ok', `detail: ${result.detail}`);
});

test('checkLocalBinOnPath: warn when missing', () => {
  const result = checkLocalBinOnPath({
    home: join('/home', 'test'),
    pathEnv: [join('/usr', 'bin'), join('/bin')].join(delimiter),
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

// --- federation sync health -------------------------------------------------
// The daemon already records every failure; the point of these is that
// something the user actually sees now reads that record.

function fedDir(name, state) {
  const dir = mkdtempSync(join(tmpdir(), name));
  mkdirSync(join(dir, 'federation'), { recursive: true });
  writeFileSync(join(dir, 'federation', 'config.json'), JSON.stringify({ hub: {} }));
  if (state !== undefined) {
    writeFileSync(join(dir, 'federation', 'sync-state.json'), JSON.stringify(state));
  }
  return dir;
}

const NOW = Date.UTC(2026, 8, 8, 12, 0, 0);
const secs = (ms) => Math.floor(ms / 1000);

test('checkFederationSyncHealth: ok when federation is not configured', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-fed-none-'));
  const r = checkFederationSyncHealth({ pluginData: dir, now: NOW });
  assert.equal(r.status, 'ok');
  rmSync(dir, { recursive: true, force: true });
});

test('checkFederationSyncHealth: configured with no state has never completed a cycle', () => {
  const dir = fedDir('health-fed-nostate-');
  const r = checkFederationSyncHealth({ pluginData: dir, now: NOW });
  assert.equal(r.status, 'fail');
  assert.match(r.detail, /has ever completed/);
  rmSync(dir, { recursive: true, force: true });
});

test('checkFederationSyncHealth: a terminal error is reported as unrecoverable', () => {
  const dir = fedDir('health-fed-terminal-', {
    outcome: 'error',
    detail: 'envelope exceeds hard cap 16777216 bytes',
    terminal: true,
    consecutive_failures: 1,
    last_success_at: secs(NOW) - 60,
  });
  const r = checkFederationSyncHealth({ pluginData: dir, now: NOW });
  assert.equal(r.status, 'fail');
  assert.match(r.detail, /cannot recover by retrying/);
  rmSync(dir, { recursive: true, force: true });
});

test('checkFederationSyncHealth: a run of failures is reported with its length', () => {
  const dir = fedDir('health-fed-streak-', {
    outcome: 'error',
    detail: 'ws: IO error: Broken pipe (os error 32)',
    consecutive_failures: 7,
    last_success_at: secs(NOW) - 60,
  });
  const r = checkFederationSyncHealth({ pluginData: dir, now: NOW });
  assert.equal(r.status, 'fail');
  assert.match(r.detail, /failed 7 times in a row/);
  rmSync(dir, { recursive: true, force: true });
});

test('checkFederationSyncHealth: one failure is not yet an alarm', () => {
  const dir = fedDir('health-fed-blip-', {
    outcome: 'error',
    detail: 'transient',
    consecutive_failures: 1,
    last_success_at: secs(NOW) - 60,
  });
  const r = checkFederationSyncHealth({ pluginData: dir, now: NOW });
  assert.equal(r.status, 'ok', 'a blip must not cry wolf');
  rmSync(dir, { recursive: true, force: true });
});

test('checkFederationSyncHealth: a daemon that stopped ticking is caught by staleness', () => {
  // outcome ok, no streak — nothing is writing failures because nothing runs.
  const dir = fedDir('health-fed-silent-', {
    outcome: 'ok',
    consecutive_failures: 0,
    last_success_at: secs(NOW) - 3600,
  });
  const r = checkFederationSyncHealth({ pluginData: dir, syncIntervalSecs: 300, now: NOW });
  assert.equal(r.status, 'fail');
  assert.match(r.detail, /no successful sync in \d+ minutes/);
  rmSync(dir, { recursive: true, force: true });
});

test('checkFederationSyncHealth: a healthy recent sync is ok', () => {
  const dir = fedDir('health-fed-ok-', {
    outcome: 'ok',
    consecutive_failures: 0,
    last_success_at: secs(NOW) - 120,
  });
  const r = checkFederationSyncHealth({ pluginData: dir, now: NOW });
  assert.equal(r.status, 'ok');
  rmSync(dir, { recursive: true, force: true });
});

test('checkFederationSyncHealth: a BOM on sync-state.json is not a dead federation', () => {
  // `readJsonOrNull` was the 23rd hand-rolled `JSON.parse(readFileSync)` in
  // this repo, and strictly weaker than the `safeLoad` that exists because an
  // audit found the other 22: no BOM strip. A BOM'd sync-state.json — what an
  // editor writes on Windows — made `JSON.parse` throw, which read as "no
  // state", which reported a healthy vault as never having synced.
  const dir = fedDir('health-fed-bom-');
  writeFileSync(
    join(dir, 'federation', 'sync-state.json'),
    `\ufeff${JSON.stringify({
      outcome: 'ok',
      consecutive_failures: 0,
      last_success_at: secs(NOW) - 60,
    })}`,
  );

  const r = checkFederationSyncHealth({ pluginData: dir, now: NOW });

  assert.equal(r.status, 'ok', `detail: ${r.detail}`);
  rmSync(dir, { recursive: true, force: true });
});

test('checkFederationSyncHealth: a corrupt registry is a failure, not a fresh install', () => {
  // `vaults.json` names every profile on the machine. Unreadable means nothing
  // resolves and nothing syncs -- and the old code returned `ok('not
  // configured')`, which is exactly what a machine that has never federated
  // reports. The Rust loader has refused this since
  // `a_corrupt_registry_errors_instead_of_looking_empty`; this is the same
  // claim on the side the user actually reads.
  const dir = mkdtempSync(join(tmpdir(), 'health-fed-corrupt-'));
  writeFileSync(join(dir, 'vaults.json'), '{not valid json');

  const r = checkFederationSyncHealth({ pluginData: dir, now: NOW });

  assert.equal(r.status, 'fail');
  assert.match(r.detail, /present but names no vault list/);
  rmSync(dir, { recursive: true, force: true });
});

test('checkFederationSyncHealth: a registry with an empty vault list is not configured', () => {
  // The other side. A registry that parses and lists nothing is a real state
  // -- `ll vault add` writes one before the first profile -- and must stay ok,
  // or the check above would just be "any registry is a failure".
  const dir = mkdtempSync(join(tmpdir(), 'health-fed-empty-reg-'));
  writeFileSync(join(dir, 'vaults.json'), JSON.stringify({ vaults: [] }));

  const r = checkFederationSyncHealth({ pluginData: dir, now: NOW });

  assert.equal(r.status, 'ok');
  assert.match(r.detail, /not configured/);
  rmSync(dir, { recursive: true, force: true });
});

test('checkFederationSyncHealth: a second vault profile is walked and named', () => {
  // The multi-vault walk had no test at all: every case above has one implicit
  // profile, so the registry branch was never entered by any of them.
  const root = mkdtempSync(join(tmpdir(), 'health-fed-multi-'));
  const good = fedDir('health-fed-multi-good-', {
    outcome: 'ok',
    consecutive_failures: 0,
    last_success_at: secs(NOW) - 60,
  });
  const broken = fedDir('health-fed-multi-bad-', {
    outcome: 'error',
    detail: 'hub refused the key',
    consecutive_failures: 9,
    last_success_at: secs(NOW) - 60,
  });
  writeFileSync(
    join(root, 'vaults.json'),
    JSON.stringify({
      vaults: [
        { id: 'work', config_dir: good },
        { id: 'personal', config_dir: broken },
      ],
    }),
  );

  const r = checkFederationSyncHealth({ pluginData: root, now: NOW });

  assert.equal(r.status, 'fail', 'a healthy first profile must not mask a broken second');
  assert.match(r.detail, /^personal: /, 'the failing profile names itself');
  assert.match(r.detail, /failed 9 times in a row/);
  for (const d of [root, good, broken]) rmSync(d, { recursive: true, force: true });
});

test('checkFederationSyncHealth: every profile healthy is ok across the registry', () => {
  const root = mkdtempSync(join(tmpdir(), 'health-fed-multi-ok-'));
  const state = { outcome: 'ok', consecutive_failures: 0, last_success_at: secs(NOW) - 60 };
  const a = fedDir('health-fed-multi-a-', state);
  const b = fedDir('health-fed-multi-b-', state);
  writeFileSync(
    join(root, 'vaults.json'),
    JSON.stringify({
      vaults: [
        { id: 'work', config_dir: a },
        { id: 'personal', config_dir: b },
      ],
    }),
  );

  const r = checkFederationSyncHealth({ pluginData: root, now: NOW });

  assert.equal(r.status, 'ok');
  assert.match(r.detail, /syncing/);
  for (const d of [root, a, b]) rmSync(d, { recursive: true, force: true });
});

test('checkFederationSyncHealth: severity is fail so the session-start detector shows it', () => {
  const dir = fedDir('health-fed-sev-', { outcome: 'ok', last_success_at: secs(NOW) - 60 });
  const r = checkFederationSyncHealth({ pluginData: dir, now: NOW });
  assert.equal(r.severity, 'fail', 'health-detector.mjs filters on severity === fail');
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

  // platform is pinned, not inherited. This case is about the socket-bearing
  // host, where advising ll-watch is right; on win32 the check correctly takes
  // the no-socket branch and offers the write budget instead, so a runner-
  // dependent platform made this assert whichever host it happened to run on.
  const result = checkDuplicateGateHealth({ pluginData: dir, now, platform: 'linux' });
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

test('checkDuplicateGateHealth: daemon-sourced timeouts do not advise starting ll-watch', () => {
  // Every timeout carrying source:'daemon' means the socket was there and a live
  // daemon accepted the connection but answered too slowly. Telling the user to
  // start ll-watch sends them to fix a daemon that is already running.
  const dir = mkdtempSync(join(tmpdir(), 'health-dupgate-daemon-'));
  const now = new Date('2026-06-12T00:00:00Z');
  const month = now.toISOString().slice(0, 7);
  const lines = [];
  for (let i = 0; i < 4; i++) {
    lines.push(
      JSON.stringify({
        ts: now.toISOString(),
        module: 'pre-write-check.checkDuplicateNote',
        code: 'duplicate-gate-timeout',
        source: 'daemon',
        message: 'timeout',
      }),
    );
  }
  writeFileSync(join(dir, `hook-errors-${month}.jsonl`), lines.join('\n') + '\n');

  // Pinned for the same reason as above: a daemon-sourced timeout only means
  // "the daemon answered slowly" where a daemon can exist at all. On win32 there
  // is no socket, so the check reports the no-socket detail and this assertion
  // could never hold there.
  const result = checkDuplicateGateHealth({ pluginData: dir, now, platform: 'linux' });
  assert.equal(result.status, 'fail');
  assert.doesNotMatch(
    result.fix,
    /start the warm daemon/i,
    'the daemon is already running -- advising a start is the wrong fix',
  );
  assert.match(result.detail, /too slow|not responding|slow/i);
  rmSync(dir, { recursive: true, force: true });
});

test('checkDuplicateGateHealth: does not advise ll-watch on a platform with no socket', () => {
  // The daemon serves the gate over a UDS socket, and nli_server.rs is
  // `#![cfg(unix)]` -- there is no socket and no named pipe on Windows, so the
  // warm path does not exist there at all. Every timeout is therefore
  // subprocess- or budget-sourced, which the daemonIsUp heuristic reads as
  // "daemon down" and answers with "start the warm daemon (ll-watch)". That is
  // advice that cannot work: the reporter of #5 had ll-watch already running
  // and still had 55 timeouts, because starting it changes nothing here.
  const dir = mkdtempSync(join(tmpdir(), 'health-dupgate-nosock-'));
  const now = new Date('2026-06-12T00:00:00Z');
  const month = now.toISOString().slice(0, 7);
  const lines = Array(6)
    .fill(null)
    .map(() =>
      JSON.stringify({
        ts: now.toISOString(),
        module: 'pre-write-check.checkDuplicateNote',
        code: 'duplicate-gate-timeout',
        source: 'subprocess',
        message: 'ETIMEDOUT',
      }),
    );
  writeFileSync(join(dir, `hook-errors-${month}.jsonl`), lines.join('\n') + '\n');

  const result = checkDuplicateGateHealth({ pluginData: dir, now, platform: 'win32' });

  assert.equal(result.status, 'fail');
  assert.doesNotMatch(
    result.fix,
    /ll-watch/,
    'there is no socket transport on this platform -- a daemon cannot serve the gate here',
  );
  assert.match(
    result.fix,
    /budget|LL_PRE_WRITE_BUDGET_MS/i,
    'the actionable lever on a no-socket host is the write budget, not the daemon',
  );
  rmSync(dir, { recursive: true, force: true });
});

// A daemon timeout is not the gate failing. checkDuplicateNote falls through to
// a cold subprocess, and the write only goes unchecked when THAT also fails
// (source 'subprocess' or 'budget'). Measured on a real install: 20 daemon
// timeouts produced 2 unchecked writes. Reporting "silently disabled" off the
// daemon count alone tells the user they have lost a safety net they still have,
// and hides the two occasions they actually lost it.
test('checkDuplicateGateHealth: daemon timeouts alone report degraded, not disabled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-dupgate-degraded-'));
  const now = new Date('2026-06-12T00:00:00Z');
  const month = now.toISOString().slice(0, 7);
  const lines = Array(4)
    .fill(null)
    .map(() =>
      JSON.stringify({
        ts: now.toISOString(),
        module: 'pre-write-check.checkDuplicateNote',
        code: 'duplicate-gate-timeout',
        source: 'daemon',
        message: 'timeout',
      }),
    );
  writeFileSync(join(dir, `hook-errors-${month}.jsonl`), lines.join('\n') + '\n');

  const result = checkDuplicateGateHealth({ pluginData: dir, now, platform: 'linux' });
  assert.equal(result.status, 'fail');
  assert.doesNotMatch(
    result.detail,
    /silently disabled|falls open|gate is disabled/i,
    'no subprocess or budget failure was logged, so no write went unchecked',
  );
  assert.match(result.detail, /slow/i, 'the daemon answering slowly is the real symptom');
  rmSync(dir, { recursive: true, force: true });
});

// PRE_WRITE_DAEMON_TIMEOUT_MS has no env or config override: it is read once at
// pre-write-check.js:161 and nowhere else. LL_PRE_WRITE_BUDGET_MS overrides
// preWriteBudgetMs(), the OUTER hook deadline, which only sizes the subprocess
// fallback's window. So on a daemon-sourced timeout that variable cannot help,
// and naming it sends the user to twiddle a knob with no path to the failure.
//
// The advice also must not quote measured latencies. Whatever p50/p95 a scan
// shows is a property of one machine and one vault size on one day; baked into
// a string it reads as authoritative long after it stops being true.
test('checkDuplicateGateHealth: daemon advice names no lever that cannot reach the failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-dupgate-lever-'));
  const now = new Date('2026-06-12T00:00:00Z');
  const month = now.toISOString().slice(0, 7);
  const lines = Array(4)
    .fill(null)
    .map(() =>
      JSON.stringify({
        ts: now.toISOString(),
        module: 'pre-write-check.checkDuplicateNote',
        code: 'duplicate-gate-timeout',
        source: 'daemon',
        message: 'timeout',
      }),
    );
  writeFileSync(join(dir, `hook-errors-${month}.jsonl`), lines.join('\n') + '\n');

  const result = checkDuplicateGateHealth({ pluginData: dir, now, platform: 'linux' });
  assert.doesNotMatch(
    result.fix,
    /LL_PRE_WRITE_BUDGET_MS/,
    'that override sizes the subprocess window; it cannot widen the daemon socket wait',
  );
  assert.doesNotMatch(
    result.fix,
    /p50|p95|~\d+ms at|median/i,
    'measured latencies are machine- and vault-specific; they do not belong in shipped advice',
  );
  rmSync(dir, { recursive: true, force: true });
});

// Pinning, not TDD-derived: this passes before and after the change. It exists
// so the lever cannot be dropped everywhere to satisfy the assertion above --
// where the fallback itself failed, the outer budget IS the thing to widen.
test('checkDuplicateGateHealth: hard failures still name the budget override', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-dupgate-lever2-'));
  const now = new Date('2026-06-12T00:00:00Z');
  const month = now.toISOString().slice(0, 7);
  const lines = [
    ...Array(4)
      .fill(null)
      .map(() =>
        JSON.stringify({ ts: now.toISOString(), code: 'duplicate-gate-timeout', source: 'daemon' }),
      ),
    JSON.stringify({ ts: now.toISOString(), code: 'duplicate-gate-timeout', source: 'subprocess' }),
  ];
  writeFileSync(join(dir, `hook-errors-${month}.jsonl`), lines.join('\n') + '\n');

  const result = checkDuplicateGateHealth({ pluginData: dir, now, platform: 'linux' });
  assert.match(result.fix, /LL_PRE_WRITE_BUDGET_MS/);
  rmSync(dir, { recursive: true, force: true });
});

test('checkDuplicateGateHealth: reports unchecked writes only when the fallback also failed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-dupgate-open-'));
  const now = new Date('2026-06-12T00:00:00Z');
  const month = now.toISOString().slice(0, 7);
  const lines = [
    ...Array(4)
      .fill(null)
      .map(() =>
        JSON.stringify({ ts: now.toISOString(), code: 'duplicate-gate-timeout', source: 'daemon' }),
      ),
    JSON.stringify({ ts: now.toISOString(), code: 'duplicate-gate-timeout', source: 'subprocess' }),
  ];
  writeFileSync(join(dir, `hook-errors-${month}.jsonl`), lines.join('\n') + '\n');

  const result = checkDuplicateGateHealth({ pluginData: dir, now, platform: 'linux' });
  assert.equal(result.status, 'fail');
  assert.match(
    result.detail,
    /unchecked|without a duplicate check|1 write/i,
    'a subprocess failure is the case where a write really did skip the gate',
  );
  rmSync(dir, { recursive: true, force: true });
});

test('checkDuplicateGateHealth: still advises ll-watch where a socket exists', () => {
  // The other side, so the fix above cannot be satisfied by dropping the advice
  // everywhere: on a platform that does have the warm path, a gate timing out
  // with no daemon-sourced entries is still a daemon worth starting.
  const dir = mkdtempSync(join(tmpdir(), 'health-dupgate-sock-'));
  const now = new Date('2026-06-12T00:00:00Z');
  const month = now.toISOString().slice(0, 7);
  const lines = Array(6)
    .fill(null)
    .map(() =>
      JSON.stringify({
        code: 'duplicate-gate-timeout',
        source: 'subprocess',
        message: 'ETIMEDOUT',
      }),
    );
  writeFileSync(join(dir, `hook-errors-${month}.jsonl`), lines.join('\n') + '\n');

  const result = checkDuplicateGateHealth({ pluginData: dir, now, platform: 'darwin' });

  assert.equal(result.status, 'fail');
  assert.match(result.fix, /ll-watch/);
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

test('checkDuplicateGateHealth: scans the previous month on the writer basis', () => {
  // The scan basis must match the filenames, which monthStr() builds in LOCAL
  // time. Deriving the expected month from the same helper keeps this test
  // timezone-independent: a UTC-based reader missed the current month's file
  // for the first hours of every month east of UTC.
  const dir = mkdtempSync(join(tmpdir(), 'health-dupgate-month-'));
  const now = new Date('2026-06-15T00:30:00Z');
  const [, prevMonth] = recentMonths(now);
  const lines = Array(4)
    .fill(null)
    .map(() => JSON.stringify({ code: 'duplicate-gate-timeout', source: 'daemon' }));
  writeFileSync(join(dir, `hook-errors-${prevMonth}.jsonl`), lines.join('\n') + '\n');
  const result = checkDuplicateGateHealth({ pluginData: dir, now });
  assert.equal(result.status, 'fail', 'must scan the previous month on the local basis');
  assert.match(result.detail, /4 duplicate-gate timeouts/);
  rmSync(dir, { recursive: true, force: true });
});

test('recentMonths: agrees with the filenames monthStr writes', () => {
  // The invariant that matters: whatever the writer names a file right now,
  // the reader must include it. Timezone-independent by construction.
  const now = new Date('2026-06-15T00:30:00Z');
  const [current, previous] = recentMonths(now);
  assert.equal(current, monthStr(now));
  assert.equal(previous, monthStr(new Date(now.getFullYear(), now.getMonth() - 1, 1)));
});

test('recentMonths: wraps the year boundary (Jan -> prev Dec)', () => {
  const now = new Date(2026, 0, 15, 12, 0, 0); // local January
  assert.deepEqual(recentMonths(now), ['2026-01', '2025-12']);
});

test('recentMonths: includes the current month at a month boundary east of UTC', () => {
  // 2026-08-01 09:00 local. A UTC-based reader would still be in July here and
  // would never scan the file the writer is currently appending to.
  const now = new Date(2026, 7, 1, 9, 0, 0);
  assert.equal(recentMonths(now)[0], '2026-08');
  assert.equal(recentMonths(now)[0], monthStr(now));
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
  writeShadowLog(dir, POST_EPOCH_MONTH, [
    ...Array(10).fill(shadowPass),
    ...Array(150).fill(shadowFail),
  ]);
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
  writeShadowLog(dir, POST_EPOCH_MONTH, [
    ...Array(15).fill(shadowPass),
    ...Array(40).fill(shadowFail),
  ]);
  writeShadowLog(dir, POST_EPOCH_PREV_MONTH, [
    ...Array(10).fill(shadowPass),
    ...Array(40).fill(shadowFail),
  ]);
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

import { runQuickChecks, formatMissingDeps, execOptions } from '../plugin/scripts/health-check.mjs';

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

// The third of the four #3 false positives, and the only one with no test until
// now. It is invisible from a POSIX runner by construction: execFileSync does
// not consult PATHEXT, so on Windows a bare `claude` misses claude.cmd, reads
// as "not found", and /doctor then recommends the Linux install.sh to someone
// whose install is correct. safeExec routes through cmd.exe to fix that, and
// the decision lives in execOptions so it can be asked directly rather than by
// mocking execFileSync -- which is the middle of this, not its boundary.
// The checks above are called directly. These two pin the ORCHESTRATOR, which
// is where the platform was being dropped: checkBinaryExists and
// checkShimsExist both accept an injected platform, and runQuickChecks passed
// neither, so every win32 spelling resolved from process.platform and no POSIX
// runner could reach it. Deleting the two `platform: c.platform` arguments
// leaves every direct-call test above green.
test('runQuickChecks threads platform to the win32 binary and shim spellings', async () => {
  const home = mkdtempSync(join(tmpdir(), 'health-orch-win-'));
  const pluginData = join(home, 'plugin-data');
  mkdirSync(join(home, '.local/bin'), { recursive: true });
  mkdirSync(join(pluginData, 'bin'), { recursive: true });
  // Exactly what a correct Windows install holds, and nothing a POSIX probe
  // would accept: .cmd shims and an .exe binary.
  for (const s of SHIM_NAMES) writeFileSync(join(home, '.local/bin', `${s}.cmd`), '@echo off\r\n');
  writeFileSync(join(pluginData, 'bin', 'll-search.exe'), 'MZ');
  stageResolvableRoot(home);

  const result = await runQuickChecks({ home, pluginData, platform: 'win32' });
  const byId = (id) => result.checks.find((c) => c.id === id);

  assert.equal(byId('shims-exist').status, 'ok', `shims: ${byId('shims-exist').detail}`);
  assert.equal(byId('binary-exists').status, 'ok', `binary: ${byId('binary-exists').detail}`);
  rmSync(home, { recursive: true, force: true });
});

test('runQuickChecks without a platform still resolves the running one', async () => {
  // The SessionStart caller (health-detector.mjs) passes no platform, so the
  // argument has to stay optional or every session starts reporting a missing
  // binary. POSIX names here, no platform passed.
  const home = mkdtempSync(join(tmpdir(), 'health-orch-default-'));
  const pluginData = join(home, 'plugin-data');
  mkdirSync(join(home, '.local/bin'), { recursive: true });
  mkdirSync(join(pluginData, 'bin'), { recursive: true });
  for (const s of SHIM_NAMES)
    writeFileSync(join(home, '.local/bin', s), '#!/bin/sh\n', { mode: 0o755 });
  stageResolvableRoot(home);

  const result = await runQuickChecks({ home, pluginData });
  const shims = result.checks.find((c) => c.id === 'shims-exist');

  assert.equal(shims.status, process.platform === 'win32' ? 'fail' : 'ok', shims.detail);
  rmSync(home, { recursive: true, force: true });
});

test('execOptions routes through the shell on win32, so PATHEXT is honored', () => {
  assert.equal(execOptions('win32').shell, true);
});

test('execOptions does not invoke a shell anywhere else', () => {
  // The other side, so the case above cannot be satisfied by shelling out
  // everywhere -- which would hand every probe's argv to a shell parser on
  // platforms that never needed one.
  assert.equal(execOptions('darwin').shell, false);
  assert.equal(execOptions('linux').shell, false);
});

test('execOptions defaults to the running platform', () => {
  assert.equal(execOptions().shell, process.platform === 'win32');
});

test('execOptions carries the probe contract safeExec depends on', () => {
  // safeExec no longer spells these itself. Dropping one here would strip the
  // timeout from every version probe, and nothing else would notice.
  const o = execOptions('linux');
  assert.equal(o.timeout, 3000);
  assert.equal(o.encoding, 'utf-8');
  assert.deepEqual(o.stdio, ['ignore', 'pipe', 'ignore']);
});
