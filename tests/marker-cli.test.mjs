// tests/marker-cli.test.mjs
// scripts/marker.mjs is the ONLY write path skills use for dream/reflect
// markers (M1/M2/M5 fix). It must: stamp parseable epoch timestamps at the
// registry path, refuse a held dream lock (exit 1), reclaim a stale one,
// release idempotently, and never bypass the writeMarker resurrection guard.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = new URL('../plugin/scripts/marker.mjs', import.meta.url).pathname;

function run(args, pluginData) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, CLAUDE_PLUGIN_DATA: pluginData },
    timeout: 5000,
  });
}

test('stamp last-reflect writes epoch seconds at the registry path and prints it', () => {
  const pd = mkdtempSync(join(tmpdir(), 'll-mcli-'));
  try {
    const before = Math.floor(Date.now() / 1000);
    const r = run(['stamp', 'last-reflect'], pd);
    assert.equal(r.status, 0, r.stderr);
    const p = join(pd, 'markers', 'last-reflect');
    assert.equal(r.stdout.trim(), p);
    const ts = parseInt(readFileSync(p, 'utf8').trim(), 10);
    assert.ok(ts >= before && ts <= before + 5, `stamp ${ts} not in [${before}, ${before + 5}]`);
  } finally {
    rmSync(pd, { recursive: true, force: true });
  }
});

test('stamp last-dream writes under retrieval/', () => {
  const pd = mkdtempSync(join(tmpdir(), 'll-mcli-'));
  try {
    const r = run(['stamp', 'last-dream'], pd);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(pd, 'retrieval', 'last-dream')));
  } finally {
    rmSync(pd, { recursive: true, force: true });
  }
});

test('lock-acquire/release lifecycle: acquire → second acquire fails → release → acquire again', () => {
  const pd = mkdtempSync(join(tmpdir(), 'll-mcli-'));
  try {
    const lockPath = join(pd, 'markers', 'dream-lock');

    const r1 = run(['lock-acquire', 'dream'], pd);
    assert.equal(r1.status, 0, r1.stderr);
    assert.ok(existsSync(lockPath));

    // Fresh lock — new lock content carries no pid, so the age floor alone
    // holds it (file younger than the 1h staleness window).
    const r2 = run(['lock-acquire', 'dream'], pd);
    assert.equal(r2.status, 1, 'second acquire must fail while lock is fresh');

    const r3 = run(['lock-release', 'dream'], pd);
    assert.equal(r3.status, 0, r3.stderr);
    assert.ok(!existsSync(lockPath));

    const r4 = run(['lock-release', 'dream'], pd);
    assert.equal(r4.status, 0, 'release is idempotent');

    const r5 = run(['lock-acquire', 'dream'], pd);
    assert.equal(r5.status, 0, 'acquire after release succeeds');
  } finally {
    rmSync(pd, { recursive: true, force: true });
  }
});

test('lock-acquire reclaims a stale lock (old mtime, dead pid) — the M5 fix', () => {
  const pd = mkdtempSync(join(tmpdir(), 'll-mcli-'));
  try {
    const lockPath = join(pd, 'markers', 'dream-lock');
    mkdirSync(join(pd, 'markers'), { recursive: true });
    writeFileSync(lockPath, '2147483647'); // legacy bare-pid content, guaranteed-dead pid
    const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    utimesSync(lockPath, old, old);

    const r = run(['lock-acquire', 'dream'], pd);
    assert.equal(r.status, 0, `stale lock must be reclaimed, stderr: ${r.stderr}`);
  } finally {
    rmSync(pd, { recursive: true, force: true });
  }
});

test('unknown command/key exits 2 with usage — exit 1 is reserved for "lock held"', () => {
  const pd = mkdtempSync(join(tmpdir(), 'll-mcli-'));
  try {
    assert.equal(run(['stamp', 'dream-lock'], pd).status, 2, 'stamp only accepts timestamps');
    assert.equal(run(['frobnicate'], pd).status, 2);
  } finally {
    rmSync(pd, { recursive: true, force: true });
  }
});
