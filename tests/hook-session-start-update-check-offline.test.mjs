// Test for the offline gate in hooks/session-start/update-check.mjs.
//
// When LL_OFFLINE is set, run() must NOT spawn the update-check worker — so the
// update-check cache file is never created/stamped. When LL_OFFLINE is unset,
// run() spawns the worker, which stamps the cache (success OR failure) within a
// short window. We assert on cache-file creation as the spawn side effect,
// which is network-outcome independent (the worker stamps on every path).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const RUNNER = JSON.stringify(
  new URL('../plugin/hooks/session-start/update-check.mjs', import.meta.url).href,
);

// Run update-check.run() in a subprocess with a chosen LL_OFFLINE, against a
// fresh (uncached) updateCacheFile, then poll briefly for the worker's stamp.
function runOffline(offlineVal) {
  const dir = mkdtempSync(join(tmpdir(), 'll-updchk-'));
  const cacheFile = join(dir, 'update-check.json');
  const out = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
      const m = await import(${RUNNER});
      await m.run({ updateCacheFile: ${JSON.stringify(cacheFile)}, pluginVersion: '1.0.0' });
      // Give a detached worker time to stamp, then report whether it did.
      const { existsSync } = await import('node:fs');
      const start = Date.now();
      while (Date.now() - start < 4000) {
        if (existsSync(${JSON.stringify(cacheFile)})) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      console.log(JSON.stringify({ stamped: existsSync(${JSON.stringify(cacheFile)}) }));
    `,
    ],
    { env: { ...process.env, LL_OFFLINE: offlineVal } },
  );
  assert.equal(out.status, 0, out.stderr.toString());
  const { stamped } = JSON.parse(out.stdout.toString());
  rmSync(dir, { recursive: true, force: true });
  return stamped;
}

test('LL_OFFLINE suppresses the update-check worker spawn', () => {
  assert.equal(runOffline('1'), false, 'offline: worker must not spawn, cache stays absent');
});

test('without LL_OFFLINE the update-check worker is spawned', () => {
  // Online (default): the worker spawns and stamps the cache (success or
  // failure) — independent of whether the network call itself succeeds.
  assert.equal(runOffline(''), true, 'online: worker spawns and stamps cache');
});
