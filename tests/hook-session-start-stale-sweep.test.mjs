// Test for the stale-artifact sweep in hooks/session-start/cache-cleanup.mjs.
//
// Covers two leftovers the version-prune never reaches because they live in the
// *current* version's plugin-data:
//   1. bin/ll-search.*-bak — orphaned backups from the old delta-patch updater.
//   2. convergence/*.json older than CONVERGENCE_TTL_MS — regenerable telemetry.
//
// Fixtures use matching installed/running versions so the binary-update block
// early-returns and never spawns a downloader — isolating the sweep behaviour.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  utimesSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { run as runCacheCleanup } from '../hooks/session-start/cache-cleanup.mjs';
import { HookConfig } from '../scripts/lib/hook-config.mjs';

function makeFixture({ version = '1.25.1' } = {}) {
  const sb = mkdtempSync(join(tmpdir(), 'll-sweep-'));
  const pluginDir = join(sb, 'plugin', version);
  const pluginData = join(sb, 'plugin-data');
  const binDir = join(pluginData, 'bin');
  const convergenceDir = join(pluginData, 'convergence');
  mkdirSync(join(pluginDir, 'scripts'), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(convergenceDir, { recursive: true });

  // Matching .version so the binary-update block early-returns (no spawn).
  writeFileSync(join(binDir, '.version'), 'v' + version + '\n');

  return {
    sandbox: sb,
    binDir,
    convergenceDir,
    ctx: { pluginDir, pluginVersion: version, pluginData },
    cleanup: () => rmSync(sb, { recursive: true, force: true }),
  };
}

async function withSandbox(fx, fn) {
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = fx.ctx.pluginData;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prev;
    fx.cleanup();
  }
}

function ageFile(path, ms) {
  const t = (Date.now() - ms) / 1000;
  utimesSync(path, t, t);
}

test('sweep: removes orphaned ll-search.*-bak binaries', async () => {
  const fx = makeFixture();
  const baks = [
    'll-search.preDelta-bak',
    'll-search.preDelta2-bak',
    'll-search.preDelta3-bak',
  ].map((n) => join(fx.binDir, n));
  for (const p of baks) writeFileSync(p, 'stale-binary-bytes');

  await withSandbox(fx, async () => {
    await runCacheCleanup(fx.ctx);
    for (const p of baks) {
      assert.equal(existsSync(p), false, `should delete ${p}`);
    }
  });
});

test('sweep: preserves the live ll-search binary and .version', async () => {
  const fx = makeFixture();
  const live = join(fx.binDir, 'll-search');
  writeFileSync(live, 'live-binary');
  writeFileSync(join(fx.binDir, 'll-search.preDelta-bak'), 'stale');

  await withSandbox(fx, async () => {
    await runCacheCleanup(fx.ctx);
    assert.equal(existsSync(live), true, 'live ll-search must survive');
    assert.equal(existsSync(join(fx.binDir, '.version')), true, '.version must survive');
    assert.equal(
      existsSync(join(fx.binDir, 'll-search.preDelta-bak')),
      false,
      'stale backup must be gone',
    );
  });
});

test('sweep: deletes convergence files older than the TTL, keeps fresh ones', async () => {
  const fx = makeFixture();
  const stale = join(fx.convergenceDir, 'discovery-old.json');
  const fresh = join(fx.convergenceDir, 'discovery-recent.json');
  writeFileSync(stale, '{}');
  writeFileSync(fresh, '{}');
  ageFile(stale, HookConfig.CONVERGENCE_TTL_MS + 60_000); // just past TTL
  ageFile(fresh, HookConfig.CONVERGENCE_TTL_MS - 60_000); // just within TTL

  await withSandbox(fx, async () => {
    await runCacheCleanup(fx.ctx);
    assert.equal(existsSync(stale), false, 'stale convergence file must be deleted');
    assert.equal(existsSync(fresh), true, 'fresh convergence file must survive');
  });
});

test('sweep: no-ops cleanly when bin/ and convergence/ are absent', async () => {
  const fx = makeFixture();
  rmSync(fx.binDir, { recursive: true, force: true });
  rmSync(fx.convergenceDir, { recursive: true, force: true });

  await withSandbox(fx, async () => {
    await assert.doesNotReject(runCacheCleanup(fx.ctx));
  });
});
