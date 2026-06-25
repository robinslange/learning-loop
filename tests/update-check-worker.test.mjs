// tests/update-check-worker.test.mjs
// The detached update checker must stamp update-check.json on EVERY outcome
// (success, network error, timeout, malformed body) — an unstamped cache
// respawns the checker every session. Failure stamps must MERGE over the
// prior cache: clobbering update_available makes the update banner vanish
// the moment the machine goes offline.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(
  new URL('../plugin/hooks/session-start/update-check-worker.mjs', import.meta.url),
);

function runWorkerSync(cacheFile, installed, apiUrl, timeoutMs) {
  const args = [WORKER, cacheFile, installed, apiUrl];
  if (timeoutMs) args.push(String(timeoutMs));
  return spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 10000 });
}

// Async spawn: a spawnSync would block the event loop and starve the
// in-process test server of its 'request' callback.
function runWorker(cacheFile, installed, apiUrl, timeoutMs) {
  const args = [WORKER, cacheFile, installed, apiUrl];
  if (timeoutMs) args.push(String(timeoutMs));
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += c));
    const killer = setTimeout(() => child.kill('SIGKILL'), 10000);
    child.on('error', reject);
    child.on('close', (status) => {
      clearTimeout(killer);
      resolvePromise({ status, stderr });
    });
  });
}

function withServer(handler, fn) {
  return new Promise((resolvePromise, reject) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', async () => {
      const url = `http://127.0.0.1:${server.address().port}/`;
      try {
        resolvePromise(await fn(url));
      } catch (err) {
        reject(err);
      } finally {
        server.close();
        server.closeAllConnections?.();
      }
    });
  });
}

const PRIOR = {
  update_available: true,
  installed: '1.17.3',
  latest: '1.18.0',
  checked: 1000000000,
};

test('network-error stamp preserves a prior update_available (banner must survive offline)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-ucw-'));
  try {
    const cacheFile = join(dir, 'update-check.json');
    writeFileSync(cacheFile, JSON.stringify(PRIOR));
    // Unroutable loopback port — connection refused fires the 'error' path.
    const r = runWorkerSync(cacheFile, '1.17.3', 'http://127.0.0.1:1/');
    assert.equal(r.status, 0, r.stderr);
    const cache = JSON.parse(readFileSync(cacheFile, 'utf8'));
    assert.ok(cache.checked > PRIOR.checked, 'failure must refresh the checked stamp');
    assert.equal(cache.error, true);
    assert.equal(cache.update_available, true, 'prior update_available must be preserved');
    assert.equal(cache.latest, '1.18.0', 'last known tag must be preserved');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('timeout path stamps the cache (destroy must surface as an error)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-ucw-'));
  try {
    const cacheFile = join(dir, 'update-check.json');
    writeFileSync(cacheFile, JSON.stringify(PRIOR));
    await withServer(
      () => {
        /* accept and stall — never respond */
      },
      async (url) => {
        const r = await runWorker(cacheFile, '1.17.3', url, 200);
        assert.equal(r.status, 0, r.stderr);
        const cache = JSON.parse(readFileSync(cacheFile, 'utf8'));
        assert.ok(cache.checked > PRIOR.checked, 'timeout must refresh the checked stamp');
        assert.equal(cache.update_available, true, 'prior update_available must be preserved');
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed body (no tag_name) stamps the cache instead of returning silently', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-ucw-'));
  try {
    const cacheFile = join(dir, 'update-check.json');
    writeFileSync(cacheFile, JSON.stringify(PRIOR));
    await withServer(
      (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      },
      async (url) => {
        const r = await runWorker(cacheFile, '1.17.3', url);
        assert.equal(r.status, 0, r.stderr);
        const cache = JSON.parse(readFileSync(cacheFile, 'utf8'));
        assert.ok(cache.checked > PRIOR.checked, 'no-tag_name must refresh the checked stamp');
        assert.equal(cache.update_available, true, 'prior update_available must be preserved');
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('success path writes a fresh full stamp', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-ucw-'));
  try {
    const cacheFile = join(dir, 'update-check.json');
    await withServer(
      (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ tag_name: 'v9.9.9' }));
      },
      async (url) => {
        const r = await runWorker(cacheFile, '1.17.3', url);
        assert.equal(r.status, 0, r.stderr);
        const cache = JSON.parse(readFileSync(cacheFile, 'utf8'));
        assert.equal(cache.update_available, true);
        assert.equal(cache.latest, '9.9.9');
        assert.equal(cache.installed, '1.17.3');
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
