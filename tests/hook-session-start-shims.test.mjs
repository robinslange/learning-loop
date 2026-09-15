// A shim on disk never updates itself. cache-cleanup must rewrite one whose text
// differs from what the running version renders, and leave current ones alone.
// cache-cleanup reads HOME once at import, so it runs in a child with a sandbox
// HOME: in-process it would rewrite the developer's real ~/.local/bin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderShim } from '../plugin/scripts/lib/shims.mjs';
import { SHIM_NAMES, shimFileName } from '../plugin/scripts/lib/paths.mjs';

const REPO_PLUGIN = fileURLToPath(new URL('../plugin', import.meta.url));
const CACHE_CLEANUP = new URL('../plugin/hooks/session-start/cache-cleanup.mjs', import.meta.url)
  .href;

function withShims(fn) {
  const home = mkdtempSync(join(tmpdir(), 'll-shim-heal-'));
  const bin = join(home, '.local', 'bin');
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(home, 'data'), { recursive: true });
  for (const name of SHIM_NAMES) writeFileSync(join(bin, shimFileName(name)), renderShim(name));
  try {
    fn({ home, bin });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function runCacheCleanup(home) {
  const ctx = { pluginDir: REPO_PLUGIN, pluginVersion: '0.0.0', pluginData: join(home, 'data') };
  const code = `const { run } = await import(${JSON.stringify(CACHE_CLEANUP)}); await run(${JSON.stringify(ctx)});`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CLAUDE_PLUGIN_DATA: join(home, 'data'),
      LL_OFFLINE: '1',
    },
  });
  assert.equal(r.status, 0, r.stderr);
}

test('session start rewrites a shim an older version left behind', () => {
  withShims(({ home, bin }) => {
    const stale = join(bin, shimFileName('ll-run'));
    writeFileSync(stale, '#!/bin/bash\n# shim that sorted cache dirs itself\n');
    runCacheCleanup(home);
    assert.equal(readFileSync(stale, 'utf8'), renderShim('ll-run'));
  });
});

test('session start leaves shims that are already current untouched', () => {
  withShims(({ home, bin }) => {
    const longAgo = new Date('2001-01-01T00:00:00Z');
    for (const name of SHIM_NAMES) utimesSync(join(bin, shimFileName(name)), longAgo, longAgo);
    runCacheCleanup(home);
    for (const name of SHIM_NAMES) {
      assert.equal(
        statSync(join(bin, shimFileName(name))).mtimeMs,
        longAgo.getTime(),
        `${name} was rewritten although its text was current`,
      );
    }
  });
});
