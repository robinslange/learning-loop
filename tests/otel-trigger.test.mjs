// tests/otel-trigger.test.mjs : T2h, the marker-gated detached trigger.
// See docs/plans/otel-consolidation.md, "The trigger".
//
// Covers:
//   - maybeSpawnOtelExport: fresh marker => no spawn; stale/absent => spawn;
//     export disabled => no spawn at all (not even a marker stat cost).
//   - the worker (otel-export-worker.mjs): writes the marker only on
//     result.ok; a failed export leaves the marker unwritten.
//   - two concurrent worker runs produce ONE export (the file lock holds).
//   - the hook's added work never runs the reducers inline (synchronous
//     return with no export having happened yet).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startOtlpSink } from './helpers/otlp-sink.mjs';

const WORKER = fileURLToPath(
  new URL('../plugin/hooks/session-start/otel-export-worker.mjs', import.meta.url),
);
const OTEL_EXPORT_MODULE = JSON.stringify(
  new URL('../plugin/hooks/session-start/otel-export.mjs', import.meta.url).href,
);

async function withPluginData(fn) {
  const pluginData = mkdtempSync(join(tmpdir(), 'll-otel-trigger-'));
  try {
    return await fn(pluginData);
  } finally {
    rmSync(pluginData, { recursive: true, force: true });
  }
}

function armConfig(pluginData) {
  writeFileSync(
    join(pluginData, 'config.json'),
    JSON.stringify({ otel: { export_enabled: true } }),
  );
}

function markerPath(pluginData) {
  return join(pluginData, 'markers', 'otel-export');
}

// Runs the worker to completion against a real OTLP sink, with the
// config/env seams that make isExportEnabled() true. CLAUDE_PLUGIN_DATA must
// be set: isExportEnabled()/getConfig() read it from the environment, not
// from argv, the same as the real worker inherits it from the hook process
// (plan item 6). Async spawn, not spawnSync: the sink runs in-process here,
// and spawnSync blocks this process's event loop, which would starve the
// sink's own 'request' handler and make every fetch to it time out.
function runWorker(pluginData, endpoint) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [WORKER, pluginData, markerPath(pluginData)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: pluginData,
        OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
      },
    });
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('close', (status) => resolvePromise({ status, stderr }));
  });
}

test('worker writes the marker only after a successful export', async () => {
  await withPluginData(async (pluginData) => {
    armConfig(pluginData);
    const sink = await startOtlpSink();
    try {
      const r = await runWorker(pluginData, sink.url);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(existsSync(markerPath(pluginData)), 'marker must be written on success');
    } finally {
      await sink.close();
    }
  });
});

test('a failed export leaves the marker unwritten, so the next session-start retries', async () => {
  await withPluginData(async (pluginData) => {
    armConfig(pluginData);
    // Unroutable loopback port: connection refused, runExport/exportMetrics
    // returns {ok: false} without throwing.
    const r = await runWorker(pluginData, 'http://127.0.0.1:1');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(markerPath(pluginData)), false, 'marker must stay absent on failure');
  });
});

test('two concurrent worker runs produce one export (the lock holds)', async () => {
  await withPluginData(async (pluginData) => {
    armConfig(pluginData);
    const sink = await startOtlpSink();
    try {
      const spawnOne = () =>
        new Promise((resolvePromise) => {
          const child = spawn(process.execPath, [WORKER, pluginData, markerPath(pluginData)], {
            stdio: 'ignore',
            env: {
              ...process.env,
              CLAUDE_PLUGIN_DATA: pluginData,
              OTEL_EXPORTER_OTLP_ENDPOINT: sink.url,
            },
          });
          child.on('close', () => resolvePromise());
        });
      await Promise.all([spawnOne(), spawnOne()]);
      assert.equal(sink.received.length, 1, 'exactly one export must reach the sink');
      assert.ok(existsSync(markerPath(pluginData)));
    } finally {
      await sink.close();
    }
  });
});

// maybeSpawnOtelExport: the marker-gating decision itself, run in a
// subprocess so env.mjs's frozen OTEL_EXPORTER_OTLP_ENDPOINT snapshot and
// config.mjs's cached getConfig() each start fresh per test.
function runMaybeSpawn(pluginData, { endpoint, enabled = true } = {}) {
  // maybeSpawnOtelExport itself does not need CLAUDE_PLUGIN_DATA (ctx carries
  // pluginData directly), but the spawned worker inherits process.env with no
  // override, the same as the real worker inherits it from the hook process
  // (plan item 6), so the subprocess running maybeSpawnOtelExport needs it set.
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: pluginData };
  if (endpoint) env.OTEL_EXPORTER_OTLP_ENDPOINT = endpoint;
  else delete env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (enabled) armConfig(pluginData);
  return spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
      const m = await import(${OTEL_EXPORT_MODULE});
      m.maybeSpawnOtelExport({ pluginData: ${JSON.stringify(pluginData)} });
      // Return immediately: proves the call is synchronous and does not
      // block on the export itself (reducers must never run inline).
      console.log('done');
      `,
    ],
    { encoding: 'utf8', env, timeout: 5000 },
  );
}

test('export disabled: maybeSpawnOtelExport does not spawn (no marker ever appears)', async () => {
  await withPluginData(async (pluginData) => {
    const r = runMaybeSpawn(pluginData, { endpoint: undefined, enabled: false });
    assert.equal(r.status, 0, r.stderr);
    // Give a wrongly-spawned worker a moment, then confirm nothing landed.
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(existsSync(markerPath(pluginData)), false);
  });
});

test('absent marker: export enabled spawns the worker, which eventually stamps the marker', async () => {
  await withPluginData(async (pluginData) => {
    mkdirSync(join(pluginData, 'markers'), { recursive: true });
    const sink = await startOtlpSink();
    try {
      const r = runMaybeSpawn(pluginData, { endpoint: sink.url, enabled: true });
      assert.equal(r.status, 0, r.stderr);
      const start = Date.now();
      while (Date.now() - start < 4000) {
        if (existsSync(markerPath(pluginData))) break;
        await new Promise((res) => setTimeout(res, 50));
      }
      assert.ok(existsSync(markerPath(pluginData)), 'worker should have stamped the marker by now');
    } finally {
      await sink.close();
    }
  });
});

test('fresh marker: maybeSpawnOtelExport does not spawn a second worker', async () => {
  await withPluginData(async (pluginData) => {
    mkdirSync(join(pluginData, 'markers'), { recursive: true });
    writeFileSync(markerPath(pluginData), 'true');
    const sink = await startOtlpSink();
    try {
      const r = runMaybeSpawn(pluginData, { endpoint: sink.url, enabled: true });
      assert.equal(r.status, 0, r.stderr);
      await new Promise((res) => setTimeout(res, 300));
      assert.equal(sink.received.length, 0, 'a fresh marker must suppress the spawn entirely');
    } finally {
      await sink.close();
    }
  });
});

test("the hook's call to maybeSpawnOtelExport is synchronous and never runs the reducers inline", async () => {
  await withPluginData(async (pluginData) => {
    mkdirSync(join(pluginData, 'markers'), { recursive: true });
    const sink = await startOtlpSink();
    try {
      const start = Date.now();
      const r = runMaybeSpawn(pluginData, { endpoint: sink.url, enabled: true });
      const elapsed = Date.now() - start;
      assert.equal(r.status, 0, r.stderr);
      // The call itself must return in milliseconds: a marker stat plus a
      // spawn, well under session-start's 10s budget. No export has been
      // sent by the time control returns to the caller.
      assert.ok(
        elapsed < 2000,
        `maybeSpawnOtelExport call took ${elapsed}ms, should be near-instant`,
      );
      assert.equal(sink.received.length, 0, 'no export must have happened synchronously');
    } finally {
      await sink.close();
    }
  });
});
