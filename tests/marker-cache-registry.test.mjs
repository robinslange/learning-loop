// tests/marker-cache-registry.test.mjs
// Pins the W2 marker registry: every dream/reflect marker resolves under
// plugin-data through MARKER_PATHS (single source of truth — M1-M5 fix),
// readMarker honors a ttlMs override (last-dream must outlive the 25h cache
// TTL or dream-gate would treat every install as first-run), and the dream
// lock is "held" only while its pid is alive or it is younger than the
// staleness floor (M5: a crashed dream must not block /dream forever).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import {
  MARKER_PATHS,
  readMarker,
  writeMarker,
  dreamLockHeld,
} from '../plugin/scripts/lib/marker-cache.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MARKER_CACHE_MODULE_URL = pathToFileURL(
  join(HERE, '..', 'plugin/scripts/lib/marker-cache.mjs'),
).href;

const PD = '/fake/plugin-data';

// Above Linux's pid_max ceiling (4194304) — guaranteed dead on every platform.
const DEAD_PID = 2 ** 31 - 1;

test('MARKER_PATHS resolves all five W2 markers under plugin-data', () => {
  assert.equal(MARKER_PATHS.lastDream(PD), join(PD, 'retrieval', 'last-dream'));
  assert.equal(MARKER_PATHS.lastReflect(PD), join(PD, 'markers', 'last-reflect'));
  assert.equal(MARKER_PATHS.dreamLock(PD), join(PD, 'markers', 'dream-lock'));
  assert.equal(MARKER_PATHS.dreamNudged(PD), join(PD, 'markers', 'dream-nudged'));
  assert.equal(
    MARKER_PATHS.memoryWrites(PD, 'abc123'),
    join(PD, 'markers', 'memory-writes-abc123'),
  );
  assert.equal(MARKER_PATHS.memoryWrites(PD, ''), join(PD, 'markers', 'memory-writes'));
  assert.equal(MARKER_PATHS.lastSweep(PD), join(PD, 'markers', 'last-sweep'));
});

test('readMarker ttlMs override lets a 26h-old marker survive', () => {
  const root = mkdtempSync(join(tmpdir(), 'll-marker-ttl-'));
  try {
    const p = join(root, 'retrieval', 'last-dream');
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, '1736370000'); // legacy raw-epoch content is valid JSON
    const old = (Date.now() - 26 * 60 * 60 * 1000) / 1000;
    utimesSync(p, old, old);
    assert.equal(readMarker(p), null, 'default 25h TTL must expire it');
    assert.equal(readMarker(p, { ttlMs: Infinity }), 1736370000, 'ttlMs: Infinity must read it');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writeMarker(path, epochNumber) round-trips through legacy parseInt readers', () => {
  const root = mkdtempSync(join(tmpdir(), 'll-marker-num-'));
  const savedEnv = process.env.CLAUDE_PLUGIN_DATA;
  try {
    process.env.CLAUDE_PLUGIN_DATA = root;
    const p = join(root, 'markers', 'last-reflect');
    writeMarker(p, 1736370000);
    // JSON.stringify(number) emits the bare digits — parseInt-compatible.
    assert.equal(parseInt(readFileSync(p, 'utf8').trim(), 10), 1736370000);
  } finally {
    if (savedEnv === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = savedEnv;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('dreamLockHeld: missing → false; fresh → true; old+dead-pid → false; live-pid → true', () => {
  const root = mkdtempSync(join(tmpdir(), 'll-lock-'));
  const savedEnv = process.env.CLAUDE_PLUGIN_DATA;
  try {
    process.env.CLAUDE_PLUGIN_DATA = root;
    const p = join(root, 'markers', 'dream-lock');
    assert.equal(dreamLockHeld(p), false, 'no lock file → not held');

    writeMarker(p, { pid: DEAD_PID, ts: Math.floor(Date.now() / 1000) });
    assert.equal(dreamLockHeld(p), true, 'fresh lock → held even with dead pid (age floor)');

    const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    utimesSync(p, old, old);
    assert.equal(dreamLockHeld(p), false, '2h-old lock with dead pid → stale, not held');

    // Legacy content shape: bare pid string (the old skill one-liner).
    writeFileSync(p, String(process.pid));
    assert.equal(dreamLockHeld(p), true, 'live pid → held regardless of age');
    utimesSync(p, old, old);
    assert.equal(dreamLockHeld(p), true, 'live pid → held even when old');

    // Unreadable content (leading zero is invalid JSON) → age check alone.
    writeFileSync(p, '012345');
    assert.equal(dreamLockHeld(p), true, 'corrupt content + fresh file → held (age floor)');
    utimesSync(p, old, old);
    assert.equal(dreamLockHeld(p), false, 'corrupt content + 2h-old file → stale, not held');
  } finally {
    if (savedEnv === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = savedEnv;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

// Runs `appendMemoryWrite(pluginData, sessionId, basename)` in a fresh child
// process. When `delayMs` is set, the child patches `node:fs`'s readFileSync
// via the CJS module object (createRequire) BEFORE importing marker-cache.mjs
// — ESM named-import bindings for core modules resolve through that same
// underlying CJS module object, so this reaches appendMemoryWrite's internal
// call to readFileSync even though it was imported as a named ESM binding
// (a plain `fs.readFileSync = …` on the ESM namespace throws: core-module
// namespace objects are frozen). The FIRST read of the marker file then
// blocks synchronously for `delayMs` before returning, widening that single
// call's read-modify-write window so a concurrent writer is forced to
// overlap it — deterministically, without touching production code or
// timing two process startups against each other.
function spawnAppend(pluginData, sessionId, basename, delayMs = 0) {
  const delaySetup =
    delayMs > 0
      ? `const { createRequire } = await import('node:module');` +
        `const fsCjs = createRequire(import.meta.url)('node:fs');` +
        `const origRead = fsCjs.readFileSync;` +
        `let patched = false;` +
        `fsCjs.readFileSync = (...args) => {` +
        `  const result = origRead(...args);` +
        `  if (!patched && String(args[0]).includes('memory-writes')) {` +
        `    patched = true;` +
        `    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${delayMs});` +
        `  }` +
        `  return result;` +
        `};`
      : '';
  const script =
    `(async () => {` +
    `${delaySetup}` +
    `const { appendMemoryWrite } = await import(${JSON.stringify(MARKER_CACHE_MODULE_URL)});` +
    `appendMemoryWrite(${JSON.stringify(pluginData)}, ${JSON.stringify(sessionId)}, ${JSON.stringify(basename)});` +
    `})();`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
    });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

// Forces the lost-update interleave deterministically: writer A's read of
// the marker blocks for 100ms (via the readFileSync monkey-patch above)
// before it computes its updated set and writes. Writer B, unpatched, runs
// its own full read-modify-write in well under 100ms and finishes first.
// An unlocked appendMemoryWrite lets A's in-flight read (captured before B
// wrote) clobber B's write when A finally saves — B's basename is lost. A
// properly locked appendMemoryWrite serializes the two: whichever acquires
// the marker's lock first holds it across its own delayed read, so the
// second writer's read (whether that's A's delayed read or B's fast one)
// always observes the first writer's completed write. The lock-wait budget
// (9 inter-retry sleeps x 20ms = ~180ms) comfortably exceeds A's remaining
// hold when B first contends (~60ms: the 100ms delayed read minus B's 40ms
// head start), so a correctly locked B outlasts A's hold rather than timing
// out its own lock wait.
//
// The marker is pre-seeded with an existing entry: readMarker short-circuits
// on a missing file before ever calling readFileSync (statSync throws first),
// so on a brand-new marker the delay hook — keyed on readFileSync — would
// never fire and the test would pass vacuously regardless of locking.
test("appendMemoryWrite: a slow reader and a fast writer both survive", async () => {
  const root = mkdtempSync(join(tmpdir(), 'll-marker-append-race-'));
  try {
    const path = MARKER_PATHS.memoryWrites(root, 'sess1');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(['note-existing.md']));

    const slow = spawnAppend(root, 'sess1', 'note-a.md', 100);
    await new Promise((r) => setTimeout(r, 40)); // let the slow reader start its delayed read first
    const fast = spawnAppend(root, 'sess1', 'note-b.md', 0);

    const [a, b] = await Promise.all([slow, fast]);
    assert.equal(a.code, 0, `slow writer should exit cleanly (stderr: ${a.stderr})`);
    assert.equal(b.code, 0, `fast writer should exit cleanly (stderr: ${b.stderr})`);

    const final = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(
      new Set(final),
      new Set(['note-existing.md', 'note-a.md', 'note-b.md']),
      `lost update — all three basenames must survive, got ${JSON.stringify(final)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
