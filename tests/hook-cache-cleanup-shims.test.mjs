// When SessionStart decides to re-run the shim installer.
//
// Both triggers here come from one real breakage. A 1.x install upgraded to
// 2.0.7 and kept its 1.x shims: ll-watch, ll-paths and ll-run were one-liners
// that exec'd `<plugin>/scripts/shim.mjs`, a dispatcher 2.x no longer ships.
// Every one of them failed with "learning-loop is not installed" -- on an
// install that was complete and correct -- and two plugin reloads changed
// nothing, because the registry was right and only the shims were stale.
//
// The installer had already been fixed; it writes shims that target
// watch.mjs and resolve-paths.mjs directly. What never happened was the
// rewrite. A plugin upgrade replaces the plugin, it does not re-run the
// plugin's installers, so anything written outside the versioned cache keeps
// the shape it had the day it was written.
//
// The decision is a pure function so it can be tested without redirecting
// HOME: scripts/lib/env.mjs snapshots the environment at import, so an
// in-process test cannot move ~/.local/bin, and the effect (spawning the
// installer) stays in the hook where it belongs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { shimsNeedInstall } from '../plugin/hooks/session-start/cache-cleanup.mjs';
import { SHIM_NAMES, shimFileName } from '../plugin/scripts/lib/paths.mjs';

function binDirWith(names) {
  const dir = mkdtempSync(join(tmpdir(), 'll-shimcheck-'));
  mkdirSync(join(dir, 'bin'), { recursive: true });
  for (const n of names) writeFileSync(join(dir, 'bin', n), 'shim\n');
  return join(dir, 'bin');
}

test('a correct Windows install is not four missing shims', () => {
  // The existence probe used the POSIX name on every platform. On Windows the
  // installer writes `.cmd`, so the probe reported all four missing and
  // re-spawned the installer on every single session -- the same spelling bug
  // the health check had, in the one place that could have repaired it.
  const binDir = binDirWith(SHIM_NAMES.map((n) => shimFileName(n, 'win32')));

  const needed = shimsNeedInstall({
    binDir,
    platform: 'win32',
    stampedVersion: '2.0.7',
    pluginVersion: '2.0.7',
  });

  assert.equal(needed, false, 'correctly installed .cmd shims must not look missing');
  rmSync(binDir, { recursive: true, force: true });
});

test('the POSIX names do not satisfy a Windows install', () => {
  // The other side, so the case above cannot be satisfied by never reporting
  // anything missing at all.
  const binDir = binDirWith(SHIM_NAMES);

  const needed = shimsNeedInstall({
    binDir,
    platform: 'win32',
    stampedVersion: '2.0.7',
    pluginVersion: '2.0.7',
  });

  assert.equal(needed, true, 'extensionless files are not the shims Windows runs');
  rmSync(binDir, { recursive: true, force: true });
});

test('shims written by an older plugin version are reinstalled', () => {
  // The actual 1.x -> 2.0.7 failure. Every shim is present, so a presence-only
  // check is satisfied forever, while the files point at a dispatcher that no
  // longer exists. Presence is not currency.
  const binDir = binDirWith(SHIM_NAMES.map((n) => shimFileName(n, 'linux')));

  const needed = shimsNeedInstall({
    binDir,
    platform: 'linux',
    stampedVersion: '1.41.1',
    pluginVersion: '2.0.7',
  });

  assert.equal(needed, true, 'a version change must rewrite the shims it may have changed');
  rmSync(binDir, { recursive: true, force: true });
});

test('shims never stamped at all are reinstalled', () => {
  // Every install that predates the stamp. Treating "unknown" as current would
  // leave exactly the population that has the stale shims unrepaired.
  const binDir = binDirWith(SHIM_NAMES.map((n) => shimFileName(n, 'linux')));

  const needed = shimsNeedInstall({
    binDir,
    platform: 'linux',
    stampedVersion: null,
    pluginVersion: '2.0.7',
  });

  assert.equal(needed, true, 'an unstamped install has shims of unknown vintage');
  rmSync(binDir, { recursive: true, force: true });
});

test('a current, fully installed set is left alone', () => {
  // The common path, and the one that must not spawn: this runs on every
  // SessionStart, and an unconditional reinstall would put a node spawn in
  // front of every session for no reason.
  const binDir = binDirWith(SHIM_NAMES.map((n) => shimFileName(n, 'linux')));

  const needed = shimsNeedInstall({
    binDir,
    platform: 'linux',
    stampedVersion: '2.0.7',
    pluginVersion: '2.0.7',
  });

  assert.equal(needed, false, 'nothing changed, so nothing to rewrite');
  rmSync(binDir, { recursive: true, force: true });
});

test('a missing shim reinstalls even when the stamp is current', () => {
  // The trigger that already existed keeps working: ll-run was added to
  // SHIM_NAMES after installs existed, and those installs are at the current
  // version with a shim they have never received.
  const binDir = binDirWith(
    SHIM_NAMES.filter((n) => n !== 'll-run').map((n) => shimFileName(n, 'linux')),
  );

  const needed = shimsNeedInstall({
    binDir,
    platform: 'linux',
    stampedVersion: '2.0.7',
    pluginVersion: '2.0.7',
  });

  assert.equal(needed, true, 'a shim the install has never received is still missing');
  rmSync(binDir, { recursive: true, force: true });
});
