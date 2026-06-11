#!/usr/bin/env node
// Learning Loop — Stop hook
// Nudges consolidation once if the session was substantial.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { home, resolvePluginData, readStdin, getSessionId } from './lib/common.mjs';
import { HookConfig } from '../scripts/lib/hook-config.mjs';
import { env } from '../scripts/lib/env.mjs';
import { logError } from '../scripts/lib/log.mjs';
import { emitJson } from './lib/io.mjs';
import { readMarker, writeMarker, MARKER_PATHS } from '../scripts/lib/marker-cache.mjs';

const tmp = tmpdir();

function now() {
  return Math.floor(Date.now() / 1000);
}

const input = await readStdin();

if (!input.trim()) process.exit(0);

let hookData;
try {
  hookData = JSON.parse(input);
} catch {
  process.exit(0);
}

// Check if stop hook is already active (prevent loops)
if (hookData.stop_hook_active) process.exit(0);

const pluginData = resolvePluginData();

// Prefer the hook-supplied session_id; fall back to the canonical marker
// resolver. getSessionId() returns 'unknown' when no marker is usable; the
// snapshot-path selection below treats that as "no session" (falsy).
let sessionId = hookData.session_id || getSessionId();
if (sessionId === 'unknown') sessionId = '';

// All dream/reflect markers live in plugin-data (MARKER_PATHS) — never tmp:
// the skill's bash inherits $TMPDIR, hook subprocesses don't, so tmp-anchored
// markers diverge across the boundary (the M1/M2 split-brain). Without
// plugin-data nothing can have written markers either — skip cooldowns.

// Skip if /reflect was run recently (within last REFLECT_COOLDOWN_SECS).
if (pluginData) {
  const lastReflect = readMarker(MARKER_PATHS.lastReflect(pluginData), { ttlMs: Infinity });
  if (typeof lastReflect === 'number' && now() - lastReflect < HookConfig.REFLECT_COOLDOWN_SECS) {
    process.exit(0);
  }
}

// Check if many new memory files were created this session (dream nudge).
const projectDir = env.CLAUDE_PROJECT_DIR;

if (pluginData && projectDir) {
  const snapshotArr = readMarker(MARKER_PATHS.memorySnapshot(pluginData, sessionId), {
    ttlMs: Infinity,
  });
  if (Array.isArray(snapshotArr)) {
    const encodedPath = projectDir.replace(/[/\\]/g, '-');
    const memoryDir = join(home(), '.claude', 'projects', encodedPath, 'memory');
    try {
      const snapshot = new Set(snapshotArr);
      const currentFiles = readdirSync(memoryDir).filter((f) => f.endsWith('.md'));
      const newMemoryCount = currentFiles.filter((f) => !snapshot.has(f)).length;

      if (newMemoryCount >= 3) {
        // Skip if dream ran recently (last DREAM_COOLDOWN_SECS).
        const lastDream = readMarker(MARKER_PATHS.lastDream(pluginData), { ttlMs: Infinity });
        const dreamRecent =
          typeof lastDream === 'number' && now() - lastDream < HookConfig.DREAM_COOLDOWN_SECS;

        // Once-guard (M3): nudge at most once per session. Legacy marker
        // content was a bare timestamp; honor it via the cooldown window.
        const nudgedPath = MARKER_PATHS.dreamNudged(pluginData);
        const nudged = readMarker(nudgedPath, { ttlMs: Infinity });
        const nudgedTs = typeof nudged === 'number' ? nudged : nudged?.ts;
        const alreadyNudged = nudged
          ? sessionId && nudged?.session_id
            ? nudged.session_id === sessionId
            : typeof nudgedTs === 'number' && now() - nudgedTs < HookConfig.DREAM_COOLDOWN_SECS
          : false;

        if (!dreamRecent && !alreadyNudged) {
          writeMarker(nudgedPath, { ts: now(), session_id: sessionId });
          emitJson({
            decision: 'block',
            reason: `This session created ${newMemoryCount} new memory files. Consider running /dream to consolidate before ending.`,
          });
          process.exit(0);
        }
      }
    } catch (err) {
      logError('stop-nudge.memoryDiff', err);
    }
  }
}

// Check transcript size as a proxy for session substance
const transcriptPath = hookData.transcript_path || '';
if (!transcriptPath || !existsSync(transcriptPath)) process.exit(0);

// Skip if we already nudged this session (keyed by transcript path hash)
const pathHash = createHash('md5').update(transcriptPath).digest('hex');
const nudgeMarker = join(tmp, `learning-loop-stop-nudged-${pathHash}`);
if (existsSync(nudgeMarker)) process.exit(0);

// Trigger on size threshold OR message count (union: preserves characterisation test
// which uses a 60KB plain-text buffer with no JSONL lines).
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
  writeFileSync(nudgeMarker, String(now()));
  emitJson({
    decision: 'block',
    reason:
      'This was a substantial session. Before ending, consider whether there are learnings worth capturing. You can run /reflect to consolidate, or if nothing notable was learned, proceed to end the session.',
  });
}
