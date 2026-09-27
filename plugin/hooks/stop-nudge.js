#!/usr/bin/env node
// Learning Loop — Stop hook
// Nudges consolidation once per session if the session was substantial.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { readPayload } from './lib/common.mjs';
import { sessionIdFrom } from '../scripts/lib/session.mjs';
import { HookConfig } from '../scripts/lib/hook-config.mjs';
import { env } from '../scripts/lib/env.mjs';
import { resolveMemoryDir } from '../scripts/lib/memory-paths.mjs';
import { logError } from '../scripts/lib/log.mjs';
import { emitJson } from './lib/io.mjs';
import { readMarker, writeMarker, MARKER_PATHS } from '../scripts/lib/marker-cache.mjs';
import { getPluginData } from '../scripts/lib/config.mjs';

function now() {
  return Math.floor(Date.now() / 1000);
}

const hookData = await readPayload('stop-nudge');
if (!hookData) process.exit(0);

// Check if stop hook is already active (prevent loops)
if (hookData.stop_hook_active) process.exit(0);

const pluginData = getPluginData();
const sessionId = sessionIdFrom(hookData);

// All dream/reflect markers live in plugin-data (MARKER_PATHS) — never tmp:
// the skill's bash inherits $TMPDIR, hook subprocesses don't, so tmp-anchored
// markers diverge across the boundary (the M1/M2 split-brain). Without
// plugin-data and a session id there is nowhere to keep the once-guard, so
// there is no nudge either.
if (!pluginData || !sessionId) process.exit(0);

// Usage probe: record what this session actually did with the notes it was
// shown, before any of the nudge gates below can exit. Without this, usage
// evidence exists only for sessions that ran /reflect, and every
// retrieval-quality number in this repo is measured against that
// self-selected slice.
//
// Runs on its own budget and swallows its own failures: telemetry must never
// be the reason a session's Stop hook fails.
if (hookData.transcript_path) {
  try {
    const { runUsageProbe } = await import('../scripts/lib/usage-probe-run.mjs');
    runUsageProbe({
      pluginData,
      sessionId,
      transcriptPath: hookData.transcript_path,
    });
  } catch (err) {
    logError('stop-nudge.usageProbe', err);
  }
}

// Skip if /reflect was run recently (within last REFLECT_COOLDOWN_SECS).
const lastReflect = readMarker(MARKER_PATHS.lastReflect(pluginData), { ttlMs: Infinity });
if (typeof lastReflect === 'number' && now() - lastReflect < HookConfig.REFLECT_COOLDOWN_SECS) {
  process.exit(0);
}

// Once per session, whichever nudge fires first.
const nudgedPath = MARKER_PATHS.stopNudged(pluginData, sessionId);
if (readMarker(nudgedPath, { ttlMs: Infinity }) !== null) process.exit(0);

// Nudge only when the once-guard persisted: emitting on a failed guard write
// re-nudges on every later stop of the session. The miss is cheap (advisory
// nudge) and writeMarker logs the failure itself.
function nudge(reason) {
  if (writeMarker(nudgedPath, now())) emitJson({ decision: 'block', reason });
  process.exit(0);
}

// Check if many new memory files were created this session (dream nudge).
const memoryDir = resolveMemoryDir(env.CLAUDE_PROJECT_DIR);

if (memoryDir) {
  // Count what THIS session wrote (post-tool's per-session write log),
  // intersected with files still on disk. Never a diff of the shared memory
  // dir: that conflated concurrent sessions and blamed one session for
  // another's writes ("this session created 31 new memory files" with zero
  // of its own).
  const writesArr = readMarker(MARKER_PATHS.memoryWrites(pluginData, sessionId), {
    ttlMs: Infinity,
  });
  if (Array.isArray(writesArr)) {
    let newMemoryCount = 0;
    try {
      const onDisk = new Set(readdirSync(memoryDir).filter((f) => f.endsWith('.md')));
      newMemoryCount = new Set(writesArr.filter((f) => onDisk.has(f))).size;
    } catch (err) {
      logError('stop-nudge.memoryDiff', err);
    }

    // Skip if dream ran recently (last DREAM_COOLDOWN_SECS).
    const lastDream = readMarker(MARKER_PATHS.lastDream(pluginData), { ttlMs: Infinity });
    const dreamRecent =
      typeof lastDream === 'number' && now() - lastDream < HookConfig.DREAM_COOLDOWN_SECS;

    if (newMemoryCount >= 3 && !dreamRecent) {
      nudge(
        `This session created ${newMemoryCount} new memory files. Consider running /dream to consolidate before ending.`,
      );
    }
  }
}

// Check transcript size as a proxy for session substance
const transcriptPath = hookData.transcript_path || '';
if (!transcriptPath || !existsSync(transcriptPath)) process.exit(0);

// Trigger on size threshold OR message count (union: the characterisation
// tests exercise the size arm with a plain-text buffer that has no JSONL
// lines, and the count arm with many small lines).
let trigger = false;

try {
  const fileSize = statSync(transcriptPath).size;
  if (fileSize > HookConfig.SESSION_SIZE_THRESHOLD_BYTES) trigger = true;
} catch (err) {
  logError('stop-nudge.statTranscript', err);
  process.exit(0);
}

if (!trigger) {
  try {
    const raw = readFileSync(transcriptPath, 'utf8');
    const messageCount = raw.split('\n').filter((l) => l.trim()).length;
    if (messageCount >= HookConfig.STOP_NUDGE_MESSAGE_COUNT) trigger = true;
  } catch (err) {
    logError('stop-nudge.readTranscript', err);
  }
}

if (trigger) {
  nudge(
    'This was a substantial session. Before ending, consider whether there are learnings worth capturing. You can run /learning-loop:reflect to consolidate, or if nothing notable was learned, proceed to end the session.',
  );
}
