#!/usr/bin/env node
// Learning Loop — Dream gate check
// Called by session-start.js. Outputs a dream nudge if conditions are met.
// Conditions (dual-gate): 24+ hours AND 5+ memory files modified since last dream.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { home } from './common.mjs';

const tmp = tmpdir();
const DREAM_MARKER = join(tmp, 'learning-loop-last-dream');
const DREAM_LOCK = join(tmp, 'learning-loop-dream-lock');

function now() {
  return Math.floor(Date.now() / 1000);
}

// Abort if a dream is already running
if (existsSync(DREAM_LOCK)) process.exit(0);

// Check time gate: 24+ hours since last dream
if (existsSync(DREAM_MARKER)) {
  const lastDream = parseInt(readFileSync(DREAM_MARKER, 'utf8').trim(), 10);
  if (now() - lastDream < 86400) process.exit(0);
} else {
  // No dream marker = never dreamed. Set one and skip this session.
  writeFileSync(DREAM_MARKER, String(now()));
  process.exit(0);
}

// Check session gate: 5+ memory files modified since last dream
const projectDir = process.env.CLAUDE_PROJECT_DIR;
if (!projectDir) process.exit(0);

const encodedPath = projectDir.replace(/[/\\]/g, '-');
const memoryDir = join(home(), '.claude', 'projects', encodedPath, 'memory');

try {
  statSync(memoryDir);
} catch {
  process.exit(0);
}

const lastDreamTs = parseInt(readFileSync(DREAM_MARKER, 'utf8').trim(), 10);
let modifiedCount = 0;

for (const file of readdirSync(memoryDir)) {
  if (!file.endsWith('.md')) continue;
  try {
    const mtime = Math.floor(statSync(join(memoryDir, file)).mtimeMs / 1000);
    if (mtime > lastDreamTs) modifiedCount++;
  } catch {}
}

if (modifiedCount >= 5) {
  const dreamDate = new Date(lastDreamTs * 1000).toISOString().slice(0, 10);
  process.stdout.write(
    `Auto-memory has ${modifiedCount} files modified since last dream (${dreamDate}). Run /dream to consolidate.`
  );
}
