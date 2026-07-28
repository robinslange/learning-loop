// tests/marker-cache-registry.test.mjs
// Pins the W2 marker registry: every dream/reflect marker resolves under
// plugin-data through MARKER_PATHS (single source of truth — M1-M5 fix),
// readMarker honors a ttlMs override (last-dream must outlive the 25h cache
// TTL or dream-gate would treat every install as first-run), and the dream
// lock is "held" only while its pid is alive or it is younger than the
// staleness floor (M5: a crashed dream must not block /dream forever).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  utimesSync,
  readFileSync,
  existsSync,
} from 'node:fs';
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
// process. The child patches `node:fs`'s readFileSync via the CJS module object
// (createRequire) BEFORE importing marker-cache.mjs — ESM named-import bindings
// for core modules resolve through that same underlying CJS module object, so
// this reaches appendMemoryWrite's internal call to readFileSync even though it
// was imported as a named ESM binding (a plain `fs.readFileSync = …` on the ESM
// namespace throws: core-module namespace objects are frozen).
//
// On its FIRST marker read, the child drops a `<signalPrefix>-read` file (this
// happens INSIDE appendMemoryWrite's critical section, after the lock is held)
// and then, if `waitForBasename` is set, spins until `<waitPrefix>-read` exists
// or `maxWaitMs` elapses. This is a file-rendezvous, not a wall-clock delay:
// the waiter blocks on the OTHER writer's progress, not on a guessed duration,
// so the forced overlap is independent of process-spawn and I/O timing under
// load. The wait ceiling is a correctness backstop the locked path simply waits
// out (see the test below), never a race the waiter can lose.
function spawnAppend(
  pluginData,
  sessionId,
  basename,
  { signalDir, signalName, waitName, maxWaitMs = 0 } = {},
) {
  const hook = signalName
    ? `const { createRequire } = await import('node:module');` +
      `const fsCjs = createRequire(import.meta.url)('node:fs');` +
      `const origRead = fsCjs.readFileSync;` +
      `const sig = ${JSON.stringify(join(signalDir ?? '', signalName ?? ''))};` +
      `const waitFile = ${JSON.stringify(waitName ? join(signalDir, waitName) : '')};` +
      `const deadline = Date.now() + ${maxWaitMs};` +
      `let patched = false;` +
      `fsCjs.readFileSync = (...args) => {` +
      `  const result = origRead(...args);` +
      // Must match the MARKER read only. `<path>.lock` also contains
      // 'memory-writes', and tryRemoveIfStale() readFileSync's the lockfile to
      // check the owner PID — so a bare substring test fires while the waiter
      // is still blocked at acquireLock, before it has read the marker at all.
      // That false signal released writer A early and inverted the whole
      // rendezvous (see the test below).
      `  if (!patched && String(args[0]).includes('memory-writes') && !String(args[0]).endsWith('.lock')) {` +
      `    patched = true;` +
      `    try { fsCjs.writeFileSync(sig, '1'); } catch {}` +
      `    if (waitFile) {` +
      `      while (!fsCjs.existsSync(waitFile) && Date.now() < deadline) {` +
      `        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);` +
      `      }` +
      `    }` +
      `  }` +
      `  return result;` +
      `};`
    : '';
  const script =
    `(async () => {` +
    `${hook}` +
    `const { appendMemoryWrite } = await import(${JSON.stringify(MARKER_CACHE_MODULE_URL)});` +
    `appendMemoryWrite(${JSON.stringify(pluginData)}, ${JSON.stringify(sessionId)}, ${JSON.stringify(basename)});` +
    `})();`;
  return new Promise((resolve, reject) => {
    // The child MUST see CLAUDE_PLUGIN_DATA: writeMarker() bails at its
    // pluginDataExists() guard and returns false when plugin data isn't
    // configured, so without this every append silently no-ops and the marker
    // keeps only its pre-seeded entry. Inheriting the ambient env made this
    // pass on dev machines (which have plugin data) and fail on every CI
    // runner (which does not) — the same environment coupling that hid the
    // real lock behaviour.
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData },
    });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

// Forces the lost-update interleave with a file rendezvous, not a timing race,
// so it is deterministic under arbitrary release-gate load.
//
// Writer A, on its first marker read (inside its critical section), signals
// `a-read` and then blocks until `b-read` appears or a generous ceiling
// elapses. Writer B, on its first read, signals `b-read` and returns at once.
// We start A first and wait for `a-read` — proof A has entered the read step —
// before starting B.
//
//   Locked (correct):   A holds the marker lock across its read, so B blocks at
//     acquireLock and never reaches its own read. `b-read` never appears, so A
//     waits out the ceiling, writes, and releases; B then acquires, reads A's
//     completed write, and appends. Both basenames survive. The ceiling is pure
//     slack A spends holding the lock — no contention can turn it into a loss.
//
//   Unlocked (broken):  B is not blocked, so it reaches its read WHILE A is
//     still waiting; `b-read` appears, A stops waiting immediately, and both
//     saw the pre-existing-only marker. Whichever writes second clobbers the
//     other. The lost update is provoked every run, so the test discriminates.
//
// The marker is pre-seeded: readMarker short-circuits on a missing file before
// ever calling readFileSync (statSync throws first), so on a brand-new marker
// the read hook would never fire and the test would pass vacuously.
test('appendMemoryWrite: two concurrent writers both survive (lock serializes them)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'll-marker-append-race-'));
  const sig = mkdtempSync(join(tmpdir(), 'll-marker-append-sig-'));
  try {
    const path = MARKER_PATHS.memoryWrites(root, 'sess1');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(['note-existing.md']));

    // A blocks in its read until B has also read (or 3s passes); B reads and returns.
    const a = spawnAppend(root, 'sess1', 'note-a.md', {
      signalDir: sig,
      signalName: 'a-read',
      waitName: 'b-read',
      maxWaitMs: 3000,
    });
    const aReadFile = join(sig, 'a-read');
    const aReadDeadline = Date.now() + 5000;
    while (!existsSync(aReadFile) && Date.now() < aReadDeadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.ok(existsSync(aReadFile), 'writer A must reach its marker read before B starts');

    const b = spawnAppend(root, 'sess1', 'note-b.md', {
      signalDir: sig,
      signalName: 'b-read',
    });

    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.code, 0, `writer A should exit cleanly (stderr: ${ra.stderr})`);
    assert.equal(rb.code, 0, `writer B should exit cleanly (stderr: ${rb.stderr})`);

    const final = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(
      new Set(final),
      new Set(['note-existing.md', 'note-a.md', 'note-b.md']),
      `lost update — all three basenames must survive, got ${JSON.stringify(final)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(sig, { recursive: true, force: true });
  }
});
