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
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DREAM_GATE = new URL('../hooks/lib/dream-gate.js', import.meta.url).pathname;

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
