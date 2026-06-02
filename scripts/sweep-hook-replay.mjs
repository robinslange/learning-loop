#!/usr/bin/env node
// sweep-hook-replay.mjs — Replay the post-tool dispatcher on vault notes.
//
// Background: PostToolUse hooks don't fire on subagent Write/Edit tool calls.
// Notes written by note-writer, discovery-researcher, literature-capturer,
// etc. bypass the structural backlink and typed-edge infrastructure entirely.
// This script invokes hooks/post-tool.js (the coalesced dispatcher running
// autolink + edge-infer + provenance) on one or more vault notes as if a
// main-thread Write had triggered it.
//
// Used by the post-batch sweep step in /reflect and /ingest, and by backfill
// runs for historical unhooked notes.
//
// Usage:
//   sweep-hook-replay.mjs <file> [<file> ...]
//   sweep-hook-replay.mjs --stdin                 # read newline-separated paths
//
// The dispatcher's modules are idempotent (autolink checks for existing
// [[links]] before appending; edge-infer removes outgoing edges before
// re-adding), so running on already-hooked notes is safe.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = resolve(__dirname, '..', 'hooks', 'post-tool.js');
const PER_FILE_TIMEOUT_MS = 15000;

function readStdinPaths() {
  const raw = readFileSync(0, 'utf-8');
  return raw
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
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

  // Forward LL_REFLECT_SID explicitly so the replayed post-tool.js appends to
  // the CALLING reflect session's new-notes marker. spawnSync inherits env by
  // default, but we pass it deliberately to document the handshake: /reflect
  // Step 4.4 sets LL_REFLECT_SID=$LL_SID before invoking this script, and the
  // replayed reflect-track.mjs uses it as the explicit session override. This is
  // what makes subagent-written notes reach the marker, and what keeps that
  // attribution correct when multiple /reflect runs overlap.
  const result = spawnSync('node', [HOOK_PATH], {
    input: stdin,
    encoding: 'utf-8',
    timeout: PER_FILE_TIMEOUT_MS,
    env: process.env,
  });
  if (result.status !== 0) {
    return {
      path: absPath,
      ok: false,
      reason: `post-tool.js exit ${result.status}`,
      stderr: (result.stderr || '').trim().slice(0, 500),
    };
  }
  return { path: absPath, ok: true };
}

function main() {
  const args = process.argv.slice(2);
  const wantsHelp = args.includes('--help') || args.includes('-h');
  if (args.length === 0 || wantsHelp) {
    const helpText = `sweep-hook-replay.mjs <file> [<file> ...]
sweep-hook-replay.mjs --stdin                 Read newline-separated paths from stdin

Invokes the post-tool dispatcher (hooks/post-tool.js) on one or more vault
notes, running autolink + edge-infer + provenance in fixed order. Used after
subagent writes to compensate for PostToolUse hooks not firing on subagent
tool calls.

Output: JSON summary {processed, ok, failed, failures}. Exit code 0 on full
success, 1 if any file failed, 2 on usage error.
`;
    if (wantsHelp) {
      process.stdout.write(helpText);
      process.exit(0);
    }
    process.stderr.write(helpText);
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
