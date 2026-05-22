#!/usr/bin/env node
// Learning Loop — Dream gate check
// Called by session-start.js via detached spawn. With --session-start-refresh,
// writes a marker so the next session reads from cache. Without it, emits a
// nudge string to stdout (legacy synchronous path, kept for direct CLI use).
// Conditions (dual-gate): 24+ hours AND 5+ memory files modified since last dream.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { home, resolvePluginData } from './common.mjs';
import { env } from '../../scripts/lib/env.mjs';
import { logError } from '../../scripts/lib/log.mjs';

const tmp = tmpdir();
const pluginData = resolvePluginData();
const DREAM_MARKER = pluginData
  ? join(pluginData, 'retrieval', 'last-dream')
  : join(tmp, 'learning-loop-last-dream');
// DREAM_RUNNING_MARKER is a presence signal (not a lock) — checked via existsSync only.
const DREAM_RUNNING_MARKER = join(tmp, 'learning-loop-dream-lock');

const isSessionStartRefresh = process.argv.includes('--session-start-refresh');

function now() {
  return Math.floor(Date.now() / 1000);
}

async function writeMarkerIfNeeded(nudge) {
  if (!isSessionStartRefresh) return;
  const { writeMarker, MARKER_PATHS } = await import('../../scripts/lib/marker-cache.mjs');
  const pd = resolvePluginData();
  if (pd) {
    writeMarker(MARKER_PATHS.dreamGate(pd), { nudge: nudge || null });
  }
}

// Compute nudge: null unless all gates pass and we have a real nudge string.
let nudge = null;

// Gate 1: Abort if a dream is already running.
if (existsSync(DREAM_RUNNING_MARKER)) {
  await writeMarkerIfNeeded(null);
  process.exit(0);
}

// Gate 2: Time gate — 24+ hours since last dream.
if (existsSync(DREAM_MARKER)) {
  const lastDream = parseInt(readFileSync(DREAM_MARKER, 'utf8').trim(), 10);
  if (now() - lastDream < 86400) {
    await writeMarkerIfNeeded(null);
    process.exit(0);
  }
} else {
  // No dream marker = never dreamed. Set one and skip this session.
  writeFileSync(DREAM_MARKER, String(now()));
  await writeMarkerIfNeeded(null);
  process.exit(0);
}

// Gate 3: Need CLAUDE_PROJECT_DIR to find memory dir.
const projectDir = env.CLAUDE_PROJECT_DIR;
if (!projectDir) {
  await writeMarkerIfNeeded(null);
  process.exit(0);
}

const encodedPath = projectDir.replace(/[/\\]/g, '-');
const memoryDir = join(home(), '.claude', 'projects', encodedPath, 'memory');

// Gate 4: Memory dir must exist.
try {
  statSync(memoryDir);
} catch (err) {
  logError('dream-gate.statMemoryDir', err);
  await writeMarkerIfNeeded(null);
  process.exit(0);
}

// Compute modified count.
const lastDreamTs = parseInt(readFileSync(DREAM_MARKER, 'utf8').trim(), 10);
let modifiedCount = 0;

for (const file of readdirSync(memoryDir)) {
  if (!file.endsWith('.md')) continue;
  try {
    const mtime = Math.floor(statSync(join(memoryDir, file)).mtimeMs / 1000);
    if (mtime > lastDreamTs) modifiedCount++;
  } catch (err) {
    logError('dream-gate.statFile', err);
  }
}

// Gate 5: 5+ modified files since last dream.
if (modifiedCount >= 5) {
  const dreamDate = new Date(lastDreamTs * 1000).toISOString().slice(0, 10);
  nudge = `Auto-memory has ${modifiedCount} files modified since last dream (${dreamDate}). Run /dream to consolidate.`;
}

// Write marker (if --session-start-refresh) then emit nudge to stdout.
await writeMarkerIfNeeded(nudge);
if (nudge) {
  process.stdout.write(nudge);
}
