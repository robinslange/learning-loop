// Test for the binary auto-update path in hooks/session-start/cache-cleanup.mjs.
//
// Three cases:
//   1. Installed version matches running version → downloader is NOT spawned.
//   2. Installed version lags running version → downloader IS spawned (detached).
//   3. Installed version file is absent (fresh install) → downloader IS spawned.
//
// The downloader binary is stubbed: a tiny shell script that writes a sentinel
// file we can `existsSync()` from the test. This avoids any real network hit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  chmodSync,
  rmSync,
  readFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { run as runCacheCleanup } from '../plugin/hooks/session-start/cache-cleanup.mjs';

const CLEANUP_MOD = JSON.stringify(
  new URL('../plugin/hooks/session-start/cache-cleanup.mjs', import.meta.url).href,
);

// Poll for an async side effect (detached spawn lands its file asynchronously).
async function waitForFile(path, timeoutMs = 1500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

function makeFixture({ installedVersion, runningVersion }) {
  const sb = mkdtempSync(join(tmpdir(), 'll-binup-'));
  const pluginDir = join(sb, 'plugin', runningVersion);
  const pluginParent = join(sb, 'plugin');
  const pluginData = join(sb, 'plugin-data');
  const binDir = join(pluginData, 'bin');
  mkdirSync(pluginDir, { recursive: true });
  mkdirSync(join(pluginDir, 'scripts'), { recursive: true });
  mkdirSync(binDir, { recursive: true });

  // The downloader stub: writes a sentinel so the test can confirm it ran.
  // The cache-cleanup hook spawns `node <downloader>`, so a JS file is the
  // simplest form. We write a sentinel into the plugin-data dir; the test
  // expects it to appear iff the divergence path fired.
  const sentinel = join(pluginData, 'downloader-fired');
  const downloader = join(pluginDir, 'scripts', 'download-binary.mjs');
  writeFileSync(
    downloader,
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'fired');\n`,
  );

  // Optionally seed the installed-version file.
  if (installedVersion !== null) {
    writeFileSync(join(binDir, '.version'), installedVersion + '\n');
  }

  return {
    sandbox: sb,
    sentinel,
    ctx: {
      pluginDir,
      pluginVersion: runningVersion,
      pluginData,
    },
    pluginParent,
    cleanup: () => rmSync(sb, { recursive: true, force: true }),
  };
}

test('cache-cleanup: matching versions do NOT spawn downloader', async () => {
  const fx = makeFixture({ installedVersion: 'v1.25.1', runningVersion: '1.25.1' });
  // Point the hook at our sandbox plugin-data; it reads via resolvePluginData()
  // which honours CLAUDE_PLUGIN_DATA.
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = fx.ctx.pluginData;
  try {
    await runCacheCleanup(fx.ctx);
    // Give a brief grace window in case it spawned despite matching — must NOT fire.
    const fired = await waitForFile(fx.sentinel, 300);
    assert.equal(fired, false, 'downloader must not fire when versions match');
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prev;
    fx.cleanup();
  }
});

test('cache-cleanup: lagging installed version DOES spawn downloader (detached)', async () => {
  const fx = makeFixture({ installedVersion: 'v1.20.2', runningVersion: '1.25.1' });
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = fx.ctx.pluginData;
  try {
    await runCacheCleanup(fx.ctx);
    const fired = await waitForFile(fx.sentinel, 1500);
    assert.equal(fired, true, 'downloader must fire when versions diverge');
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prev;
    fx.cleanup();
  }
});

test('cache-cleanup: missing .version file DOES spawn downloader (fresh install)', async () => {
  const fx = makeFixture({ installedVersion: null, runningVersion: '1.25.1' });
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = fx.ctx.pluginData;
  try {
    await runCacheCleanup(fx.ctx);
    const fired = await waitForFile(fx.sentinel, 1500);
    assert.equal(fired, true, 'downloader must fire on first-install (no .version file)');
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prev;
    fx.cleanup();
  }
});

test('cache-cleanup: LL_OFFLINE suppresses the downloader despite a lagging version', async () => {
  // The lagging-version fixture would normally fire the downloader (see the
  // "DOES spawn" test). With LL_OFFLINE the binary auto-update must not spawn.
  // env.mjs snapshots process.env at import, so the flag has to be set in a
  // child process before cache-cleanup is imported.
  const fx = makeFixture({ installedVersion: 'v1.20.2', runningVersion: '1.25.1' });
  try {
    const out = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
        const m = await import(${CLEANUP_MOD});
        await m.run(${JSON.stringify(fx.ctx)});
        const { existsSync } = await import('node:fs');
        const start = Date.now();
        while (Date.now() - start < 1500) {
          if (existsSync(${JSON.stringify(fx.sentinel)})) break;
          await new Promise((r) => setTimeout(r, 50));
        }
        console.log(JSON.stringify({ fired: existsSync(${JSON.stringify(fx.sentinel)}) }));
      `,
      ],
      { env: { ...process.env, LL_OFFLINE: '1', CLAUDE_PLUGIN_DATA: fx.ctx.pluginData } },
    );
    assert.equal(out.status, 0, out.stderr.toString());
    const { fired } = JSON.parse(out.stdout.toString());
    assert.equal(fired, false, 'offline: binary auto-update must not spawn the downloader');
  } finally {
    fx.cleanup();
  }
});

test('cache-cleanup: v-prefix tolerance — installed has v, running does not, treat as match', async () => {
  // Regression guard for the prefix-mismatch shape: the on-disk .version file
  // historically contains `v1.25.1` (download-binary.mjs prepends `v`) while
  // ctx.pluginVersion is the bare semver `1.25.1` (from plugin.json read).
  // stripV on both sides makes the comparison robust.
  const fx = makeFixture({ installedVersion: 'v1.25.1', runningVersion: '1.25.1' });
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = fx.ctx.pluginData;
  try {
    await runCacheCleanup(fx.ctx);
    const fired = await waitForFile(fx.sentinel, 300);
    assert.equal(
      fired,
      false,
      'v-prefix should be stripped before comparison; same version must not trigger download',
    );
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prev;
    fx.cleanup();
  }
});
