// tests/dream-gate-session-start-refresh.test.mjs
// Integration test: dream-gate.js --session-start-refresh
// writes the marker file to CLAUDE_PLUGIN_DATA/session-start-cache/dream-gate.json.
//
// dream-gate has multiple early-exit paths. This test exercises the "never
// dreamed before" path (no DREAM_MARKER), which writes the last-dream timestamp
// and exits 0. Even on this path the marker must be written with { nudge: null }.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DREAM_GATE = new URL('../hooks/lib/dream-gate.js', import.meta.url).pathname;

function runGate(pluginData, { home, env = {} } = {}) {
  return spawnSync(process.execPath, [DREAM_GATE, '--session-start-refresh'], {
    encoding: 'utf8',
    timeout: 10000,
    env: {
      PATH: process.env.PATH,
      NODE_PATH: process.env.NODE_PATH || '',
      CLAUDE_PLUGIN_DATA: pluginData,
      HOME: home,
      USERPROFILE: home,
      ...env,
    },
  });
}

test(
  'dream-gate --session-start-refresh writes dream-gate.json marker with nudge field',
  { timeout: 12000 },
  () => {
    const tmpPluginData = mkdtempSync(join(tmpdir(), 'll-dg-ssr-'));
    // Ensure retrieval/ exists so dream-gate can write DREAM_MARKER on first run.
    mkdirSync(join(tmpPluginData, 'retrieval'), { recursive: true });

    try {
      // Use a sandboxed HOME so memory-dir stat calls don't touch the real home.
      const sandboxHome = mkdtempSync(join(tmpdir(), 'll-dg-home-'));
      try {
        const result = spawnSync(
          process.execPath,
          [DREAM_GATE, '--session-start-refresh'],
          {
            encoding: 'utf8',
            timeout: 10000,
            env: {
              PATH: process.env.PATH,
              NODE_PATH: process.env.NODE_PATH || '',
              CLAUDE_PLUGIN_DATA: tmpPluginData,
              // Omit CLAUDE_PROJECT_DIR so gate 3 fires and script exits early,
              // which still exercises writeMarkerIfNeeded(null).
              HOME: sandboxHome,
              USERPROFILE: sandboxHome,
            },
          },
        );

        assert.ok(
          result.signal === null,
          `dream-gate killed by signal ${result.signal}`,
        );

        // The script exits 0 on the "first run" path (writes DREAM_MARKER then exits)
        // or on "no CLAUDE_PROJECT_DIR" path — both should write the cache marker.
        assert.equal(result.status, 0, `dream-gate exited ${result.status}\nstderr: ${result.stderr}`);

        const markerPath = join(tmpPluginData, 'session-start-cache', 'dream-gate.json');
        assert.ok(
          existsSync(markerPath),
          `marker file must exist at ${markerPath}\nstderr: ${result.stderr}`,
        );

        const raw = readFileSync(markerPath, 'utf8');
        let parsed;
        assert.doesNotThrow(() => {
          parsed = JSON.parse(raw);
        }, `marker file must be valid JSON; got: ${raw}`);

        assert.ok(
          Object.prototype.hasOwnProperty.call(parsed, 'nudge'),
          `marker must have a "nudge" field; got: ${JSON.stringify(parsed)}`,
        );
        // On an early-exit path the nudge is null (no consolidation needed).
        assert.equal(parsed.nudge, null, `nudge should be null on early-exit path; got: ${parsed.nudge}`);
      } finally {
        rmSync(sandboxHome, { recursive: true, force: true });
      }
    } finally {
      rmSync(tmpPluginData, { recursive: true, force: true });
    }
  },
);

// Regression (W5/6a): a stale nudge written before a /dream must be CLEARED
// when the gate computes "no nudge needed" (fresh last-dream → 24h gate
// fails). Pre-fix, writeMarkerIfNeeded(null) never overwrote an existing
// nudge, so the stale payload survived until the 25h marker TTL even after
// a successful dream.
test(
  'dream-gate clears a stale nudge when the gate computes no-nudge (fresh last-dream)',
  { timeout: 12000 },
  () => {
    const tmpPluginData = mkdtempSync(join(tmpdir(), 'll-dg-clear-'));
    const sandboxHome = mkdtempSync(join(tmpdir(), 'll-dg-clear-home-'));
    try {
      // Yesterday's run left a real nudge in the cache marker.
      const cacheDir = join(tmpPluginData, 'session-start-cache');
      mkdirSync(cacheDir, { recursive: true });
      const markerPath = join(cacheDir, 'dream-gate.json');
      writeFileSync(markerPath, JSON.stringify({ nudge: 'Auto-memory has 9 files modified. Run /dream to consolidate.' }));
      // /dream just succeeded: last-dream stamp is 1 hour old.
      mkdirSync(join(tmpPluginData, 'retrieval'), { recursive: true });
      writeFileSync(
        join(tmpPluginData, 'retrieval', 'last-dream'),
        String(Math.floor(Date.now() / 1000) - 3600),
      );

      const result = runGate(tmpPluginData, { home: sandboxHome });
      assert.equal(result.status, 0, `dream-gate exited ${result.status}\nstderr: ${result.stderr}`);

      const parsed = JSON.parse(readFileSync(markerPath, 'utf8'));
      assert.equal(
        parsed.nudge,
        null,
        `a fresh last-dream means "computed: no nudge" — the stale nudge must be cleared; got: ${JSON.stringify(parsed)}`,
      );
    } finally {
      rmSync(tmpPluginData, { recursive: true, force: true });
      rmSync(sandboxHome, { recursive: true, force: true });
    }
  },
);

// Companion contract pin: when the gate CANNOT compute (env missing — no
// CLAUDE_PROJECT_DIR), a prior real nudge is preserved, not clobbered.
test(
  'dream-gate preserves a prior nudge when computation fails (no CLAUDE_PROJECT_DIR)',
  { timeout: 12000 },
  () => {
    const tmpPluginData = mkdtempSync(join(tmpdir(), 'll-dg-keep-'));
    const sandboxHome = mkdtempSync(join(tmpdir(), 'll-dg-keep-home-'));
    try {
      const cacheDir = join(tmpPluginData, 'session-start-cache');
      mkdirSync(cacheDir, { recursive: true });
      const markerPath = join(cacheDir, 'dream-gate.json');
      const priorNudge = 'Auto-memory has 9 files modified. Run /dream to consolidate.';
      writeFileSync(markerPath, JSON.stringify({ nudge: priorNudge }));
      // Last dream 25h ago: the time gate passes, then gate 3 fails (no
      // CLAUDE_PROJECT_DIR) — computation could not finish.
      mkdirSync(join(tmpPluginData, 'retrieval'), { recursive: true });
      writeFileSync(
        join(tmpPluginData, 'retrieval', 'last-dream'),
        String(Math.floor(Date.now() / 1000) - 90000),
      );

      const result = runGate(tmpPluginData, { home: sandboxHome });
      assert.equal(result.status, 0, `dream-gate exited ${result.status}\nstderr: ${result.stderr}`);

      const parsed = JSON.parse(readFileSync(markerPath, 'utf8'));
      assert.equal(
        parsed.nudge,
        priorNudge,
        'a failed computation must not clobber the prior real nudge',
      );
    } finally {
      rmSync(tmpPluginData, { recursive: true, force: true });
      rmSync(sandboxHome, { recursive: true, force: true });
    }
  },
);
