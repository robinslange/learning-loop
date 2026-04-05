#!/usr/bin/env node
// Learning Loop — Stop hook
// Nudges consolidation once if the session was substantial.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { home, resolvePluginData, resolveVaultPath, readStdin, findBinary as findBinaryShared } from './lib/common.mjs';

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

// Reindex + federation sync via binary (fire and forget)
const PLUGIN_DIR = resolve(import.meta.dirname, '..');

const pluginData = resolvePluginData();

function isWatchRunning() {
  if (!pluginData) return false;
  try {
    const pid = parseInt(readFileSync(join(pluginData, 'watch.pid'), 'utf8').trim(), 10);
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

if (!isWatchRunning()) {
  const fedConfig = pluginData ? join(pluginData, 'federation', 'config.json') : null;
  try {
    const vaultRoot = resolveVaultPath();
    if (!vaultRoot) throw new Error('no vault');
    const dbPath = join(vaultRoot, '.vault-search', 'vault-index.db');
    const binary = findBinaryShared();
    if (binary) {
      const args = (fedConfig && existsSync(fedConfig))
        ? ['index', vaultRoot, dbPath, '--sync']
        : ['index', vaultRoot, dbPath];
      const child = spawn(binary.bin, args, {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, ORT_DYLIB_PATH: binary.binDir, ORT_LIB_LOCATION: binary.binDir },
      });
      child.unref();
    }
  } catch {}
}

// Skip if /reflect was run recently (within last 5 minutes)
const reflectMarker = join(tmp, 'learning-loop-last-reflect');
if (existsSync(reflectMarker)) {
  try {
    const lastReflect = parseInt(readFileSync(reflectMarker, 'utf8').trim(), 10);
    if (now() - lastReflect < 300) process.exit(0);
  } catch {}
}

// Check if many new memory files were created this session (dream nudge)
const dreamMarker = join(tmp, 'learning-loop-last-dream');
const sessionStartFile = join(tmp, 'learning-loop-session-start');
const projectDir = process.env.CLAUDE_PROJECT_DIR;

const snapshotFile = join(tmp, 'learning-loop-memory-snapshot');
if (projectDir && existsSync(snapshotFile)) {
  const encodedPath = projectDir.replace(/[/\\]/g, '-');
  const memoryDir = join(home(), '.claude', 'projects', encodedPath, 'memory');

  try {
    const snapshot = new Set(JSON.parse(readFileSync(snapshotFile, 'utf8')));
    const currentFiles = readdirSync(memoryDir).filter((f) => f.endsWith('.md'));
    const newMemoryCount = currentFiles.filter((f) => !snapshot.has(f)).length;

    if (newMemoryCount >= 3) {
      // Skip if dream ran recently (last 5 min)
      let dreamRecent = false;
      if (existsSync(dreamMarker)) {
        try {
          const lastDream = parseInt(readFileSync(dreamMarker, 'utf8').trim(), 10);
          if (now() - lastDream < 300) dreamRecent = true;
        } catch {}
      }

      if (!dreamRecent) {
        writeFileSync(join(tmp, 'learning-loop-dream-nudged'), String(now()));
        process.stdout.write(
          JSON.stringify({
            decision: 'block',
            reason: `This session created ${newMemoryCount} new memory files. Consider running /dream to consolidate before ending.`,
          })
        );
        process.exit(0);
      }
    }
  } catch {}
}

// Check transcript size as a proxy for session substance
const transcriptPath = hookData.transcript_path || '';
if (!transcriptPath || !existsSync(transcriptPath)) process.exit(0);

// Skip if we already nudged this session (keyed by transcript path hash)
const pathHash = createHash('md5').update(transcriptPath).digest('hex');
const nudgeMarker = join(tmp, `learning-loop-stop-nudged-${pathHash}`);
if (existsSync(nudgeMarker)) process.exit(0);

let fileSize;
try {
  fileSize = statSync(transcriptPath).size;
} catch {
  process.exit(0);
}

// Only nudge for substantial sessions (>50KB of transcript)
if (fileSize > 51200) {
  writeFileSync(nudgeMarker, String(now()));
  process.stdout.write(
    JSON.stringify({
      decision: 'block',
      reason: 'This was a substantial session. Before ending, consider whether there are learnings worth capturing. You can run /reflect to consolidate, or if nothing notable was learned, proceed to end the session.',
    })
  );
}
