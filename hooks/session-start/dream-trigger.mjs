// hooks/session-start/dream-trigger.mjs : nudge `/learning-loop:dream` when
// auto-memory has drifted across many sessions without consolidation.
//
// Trigger criteria (both must hold):
//   - Time since last dream > DREAM_AGE_THRESHOLD_SECS (default 24h).
//   - SessionStart count since last dream >= DREAM_SESSION_THRESHOLD (default 5).
//
// Behaviour: append a nudge to ctx.context suggesting `/learning-loop:dream`.
// Never auto-runs (consolidation is destructive).
//
// State files:
//   - $TMPDIR/learning-loop-last-dream — Unix-seconds timestamp. Written by
//     /learning-loop:dream on completion (same marker stop-nudge.js reads at
//     line 50). tmpdir is fine because a reboot is a natural "fresh start"
//     for nudge cadence.
//   - $PLUGIN_DATA/.dream-session-count — plain integer. Incremented on every
//     run() that doesn't nudge. Reset to 0 when nudging OR when the marker
//     shows a recent dream. pluginData (not tmp) so the count survives reboots.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HookConfig } from '../../scripts/lib/hook-config.mjs';
import { logError } from '../../scripts/lib/log.mjs';

const COUNTER_BASENAME = '.dream-session-count';
const MARKER_BASENAME = 'learning-loop-last-dream';

function readCounter(path) {
  if (!existsSync(path)) return 0;
  try {
    const n = parseInt(readFileSync(path, 'utf-8').trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch (err) {
    logError('dream-trigger.readCounter', err);
    return 0;
  }
}

function writeCounter(path, value) {
  try {
    writeFileSync(path, String(value));
  } catch (err) {
    logError('dream-trigger.writeCounter', err);
  }
}

function readLastDream(markerPath) {
  if (!existsSync(markerPath)) return null;
  try {
    const ts = parseInt(readFileSync(markerPath, 'utf-8').trim(), 10);
    return Number.isFinite(ts) ? ts : null;
  } catch (err) {
    logError('dream-trigger.readLastDream', err);
    return null;
  }
}

export async function run(ctx) {
  if (!ctx?.pluginData) return;

  const counterPath = join(ctx.pluginData, COUNTER_BASENAME);
  const markerPath = join(tmpdir(), MARKER_BASENAME);

  const lastDream = readLastDream(markerPath);
  const nowSecs = Math.floor(Date.now() / 1000);

  if (lastDream !== null && nowSecs - lastDream < HookConfig.DREAM_AGE_THRESHOLD_SECS) {
    writeCounter(counterPath, 0);
    return;
  }

  const next = readCounter(counterPath) + 1;
  writeCounter(counterPath, next);

  if (next < HookConfig.DREAM_SESSION_THRESHOLD) return;

  writeCounter(counterPath, 0);

  const lastDreamIso = lastDream === null ? 'never' : new Date(lastDream * 1000).toISOString();
  ctx.context +=
    `\n## Auto-memory consolidation drift\n` +
    `Auto-memory has drifted across ${next} SessionStart events without ` +
    `consolidation (last dream: ${lastDreamIso}). Consider running ` +
    `\`/learning-loop:dream\` before more drift accumulates.\n`;
}
