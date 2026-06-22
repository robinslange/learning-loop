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
import {
  MARKER_PATHS,
  readMarker,
  writeMarker,
  dreamLockHeld,
} from '../plugin/scripts/lib/marker-cache.mjs';

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
