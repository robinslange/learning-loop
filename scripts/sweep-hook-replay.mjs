#!/usr/bin/env node
// sweep-hook-replay.mjs — Replay autolink + edge-infer hooks on vault notes.
//
// Background: PostToolUse hooks (post-write-autolink.js, post-write-edge-infer.js)
// don't fire on subagent Write/Edit tool calls. Notes written by note-writer,
// discovery-researcher, literature-capturer, etc. bypass the structural backlink
// and typed-edge infrastructure entirely. This script replays the hook chain on
// one or more vault notes as if a main-thread Write had triggered them.
//
// Used by the post-batch sweep step in /reflect and /ingest, and by backfill
// runs for historical unhooked notes.
//
// Usage:
//   sweep-hook-replay.mjs <file> [<file> ...]
//   sweep-hook-replay.mjs --stdin                 # read newline-separated paths
//
// The hooks are idempotent (autolink checks for existing [[links]] before
// appending; edge-infer removes outgoing edges before re-adding), so running
// on already-hooked notes is safe.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOKS_DIR = resolve(__dirname, '..', 'hooks');
const HOOKS = ['post-write-autolink.js', 'post-write-edge-infer.js'];
const PER_FILE_TIMEOUT_MS = 15000;

function readStdinPaths() {
  const raw = readFileSync(0, 'utf-8');
  return raw.split('\n').map(s => s.trim()).filter(Boolean);
}

function replayOne(absPath) {
  let content;
  try {
    content = readFileSync(absPath, 'utf-8');
  } catch (err) {
    return { path: absPath, ok: false, reason: `read failed: ${err.message}` };
  }

  const stdin = JSON.stringify({
    tool_name: 'Write',
    tool_input: { file_path: absPath, content },
    tool_response: { success: true },
  });

  for (const hook of HOOKS) {
    const hookPath = resolve(HOOKS_DIR, hook);
    const result = spawnSync('node', [hookPath], {
      input: stdin,
      encoding: 'utf-8',
      timeout: PER_FILE_TIMEOUT_MS,
    });
    if (result.status !== 0) {
      return {
        path: absPath,
        ok: false,
        reason: `${hook} exit ${result.status}`,
        stderr: (result.stderr || '').trim().slice(0, 500),
      };
    }
  }
  return { path: absPath, ok: true };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.stderr.write('usage: sweep-hook-replay.mjs <file> [<file> ...] | --stdin\n');
    process.exit(2);
  }

  let paths;
  if (args.includes('--stdin')) {
    paths = readStdinPaths();
  } else {
    paths = args;
  }

  if (paths.length === 0) {
    process.stdout.write(JSON.stringify({ processed: 0, ok: 0, failed: 0, failures: [] }) + '\n');
    return;
  }

  const failures = [];
  let ok = 0;
  for (const p of paths) {
    const abs = resolve(p);
    if (!existsSync(abs)) {
      failures.push({ path: abs, reason: 'file not found' });
      continue;
    }
    const result = replayOne(abs);
    if (result.ok) ok++;
    else failures.push(result);
  }

  const summary = {
    processed: paths.length,
    ok,
    failed: failures.length,
    failures: failures.slice(0, 20),
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  process.exit(failures.length > 0 ? 1 : 0);
}

main();
