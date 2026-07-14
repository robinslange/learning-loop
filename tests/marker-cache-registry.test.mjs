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
// process. Before calling it, the child writes its own ready-file into
// `barrierDir` and busy-polls (short Atomics.wait sleeps — no setTimeout
// jitter) until the OTHER writer's ready-file also exists. This is a real
// rendezvous barrier: both children only proceed into appendMemoryWrite once
// BOTH have signaled ready, so they enter the read-modify-write at
// essentially the same instant regardless of how long process spawn or ESM
// resolution took for either one. A fixed setTimeout-based stagger (tried
// first) can only hit the actual read-modify-write window — a few hundred
// microseconds — by luck: it was empirically flaky in both directions,
// sometimes missing the race against unlocked code and sometimes exhausting
// appendMemoryWrite's own retry budget against locked code. The barrier
// removes the guesswork.
function spawnAppend(pluginData, sessionId, basename, barrierDir, readyName, otherReadyName) {
  const script =
    `import('node:fs').then(async (fs) => {` +
    `  fs.writeFileSync(${JSON.stringify(join(barrierDir, readyName))}, '1');` +
    `  const other = ${JSON.stringify(join(barrierDir, otherReadyName))};` +
    `  const buf = new Int32Array(new SharedArrayBuffer(4));` +
    `  while (!fs.existsSync(other)) { Atomics.wait(buf, 0, 0, 1); }` +
    `  const { appendMemoryWrite } = await import(${JSON.stringify(MARKER_CACHE_MODULE_URL)});` +
    `  appendMemoryWrite(${JSON.stringify(pluginData)}, ${JSON.stringify(sessionId)}, ${JSON.stringify(basename)});` +
    `});`;
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

// Runs one barrier-synchronized pair of concurrent appendMemoryWrite calls
// against a fresh marker and reports whether both basenames survived.
async function runRacePair(sessionId) {
  const root = mkdtempSync(join(tmpdir(), 'll-marker-append-race-'));
  const barrierDir = mkdtempSync(join(tmpdir(), 'll-marker-append-barrier-'));
  try {
    const path = MARKER_PATHS.memoryWrites(root, sessionId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(['note-existing.md']));

    const [a, b] = await Promise.all([
      spawnAppend(root, sessionId, 'note-a.md', barrierDir, 'a', 'b'),
      spawnAppend(root, sessionId, 'note-b.md', barrierDir, 'b', 'a'),
    ]);
    if (a.code !== 0) throw new Error(`writer A exited ${a.code} (stderr: ${a.stderr})`);
    if (b.code !== 0) throw new Error(`writer B exited ${b.code} (stderr: ${b.stderr})`);

    const final = JSON.parse(readFileSync(path, 'utf8'));
    const got = new Set(final);
    return { ok: got.size === 3 && got.has('note-a.md') && got.has('note-b.md'), final };
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(barrierDir, { recursive: true, force: true });
  }
}

// A single barrier-synchronized pair collides on the actual read-modify-write
// window (not process-startup timing) roughly 40% of the time against
// unlocked code, measured empirically — the window itself is real but
// sub-millisecond, so any single trial can land on either side of it purely
// from OS scheduling noise. Running pairs SEQUENTIALLY (not all in parallel)
// keeps this test's own footprint to 2 concurrent child processes at a time
// — running many pairs at once was empirically flaky under `npm test`'s full
// parallel suite load (extra processes competing for CPU can exhaust
// appendMemoryWrite's fixed retry budget on legitimate scheduling delay
// alone, which looks identical to a lost update from the outside). 6
// sequential trials drives the chance of missing every collision down to
// roughly 0.6^6 ≈ 4.7% while adding minimal load of its own: a properly
// locked appendMemoryWrite must pass every trial; an unlocked one reliably
// drops a basename in at least one.
test('appendMemoryWrite: repeated barrier-synchronized concurrent writer pairs all survive', async () => {
  const failures = [];
  for (let i = 0; i < 6; i++) {
    const r = await runRacePair(`sess${i}`);
    if (!r.ok) failures.push(`pair ${i}: got ${JSON.stringify(r.final)}`);
  }
  assert.deepEqual(
    failures,
    [],
    `lost update(s) — both concurrent basenames must survive every pair:\n${failures.join('\n')}`,
  );
});
