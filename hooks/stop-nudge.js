#!/usr/bin/env node
// Learning Loop — Stop hook
// Nudges consolidation once if the session was substantial.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { home, resolvePluginData, readStdin } from './lib/common.mjs';
import { safeLoad } from '../scripts/lib/safe-load.mjs';
import { HookConfig } from '../scripts/lib/hook-config.mjs';
import { env } from '../scripts/lib/env.mjs';
import { logError } from '../scripts/lib/log.mjs';
import { emitJson } from './lib/io.mjs';

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

// Skip if /reflect was run recently (within last REFLECT_COOLDOWN_SECS)
const reflectMarker = join(tmp, 'learning-loop-last-reflect');
if (existsSync(reflectMarker)) {
  try {
    const lastReflect = parseInt(readFileSync(reflectMarker, 'utf8').trim(), 10);
    if (now() - lastReflect < HookConfig.REFLECT_COOLDOWN_SECS) process.exit(0);
  } catch (err) {
    logError('stop-nudge.reflectMarker', err);
  }
}

// Check if many new memory files were created this session (dream nudge)
const dreamMarker = join(tmp, 'learning-loop-last-dream');
const projectDir = env.CLAUDE_PROJECT_DIR;

// Resolve session ID: hook input > ppid-keyed file > global file (legacy)
let sessionId = hookData.session_id || '';
if (!sessionId) {
  try {
    sessionId = readFileSync(join(tmp, `learning-loop-session-id-${process.ppid}`), 'utf8').trim();
  } catch (err) {
    logError('stop-nudge.sessionId.ppid', err);
  }
}
if (!sessionId) {
  try {
    sessionId = readFileSync(join(tmp, 'learning-loop-session-id'), 'utf8').trim();
  } catch (err) {
    logError('stop-nudge.sessionId.legacy', err);
  }
}

const snapshotFile = sessionId
  ? join(tmp, `learning-loop-memory-snapshot-${sessionId}`)
  : join(tmp, 'learning-loop-memory-snapshot');
if (projectDir && existsSync(snapshotFile)) {
  const encodedPath = projectDir.replace(/[/\\]/g, '-');
  const memoryDir = join(home(), '.claude', 'projects', encodedPath, 'memory');

  try {
    const { value: snapshotArr } = safeLoad(snapshotFile, { fallback: [] });
    const snapshot = new Set(Array.isArray(snapshotArr) ? snapshotArr : []);
    const currentFiles = readdirSync(memoryDir).filter((f) => f.endsWith('.md'));
    const newMemoryCount = currentFiles.filter((f) => !snapshot.has(f)).length;

    if (newMemoryCount >= 3) {
      // Skip if dream ran recently (last DREAM_COOLDOWN_SECS)
      let dreamRecent = false;
      if (existsSync(dreamMarker)) {
        try {
          const lastDream = parseInt(readFileSync(dreamMarker, 'utf8').trim(), 10);
          if (now() - lastDream < HookConfig.DREAM_COOLDOWN_SECS) dreamRecent = true;
        } catch (err) {
          logError('stop-nudge.dreamMarker', err);
        }
      }

      if (!dreamRecent) {
        writeFileSync(join(tmp, 'learning-loop-dream-nudged'), String(now()));
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
