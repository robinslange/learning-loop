#!/usr/bin/env node
// Learning Loop — PreCompact hook (spike).
//
// PreCompact cannot inject context into Claude's conversation (the universal
// hook schema rejects `hookSpecificOutput` for this event). Instead, this
// hook spawns a detached worker that reads the pre-compaction transcript and
// extracts atomic notes to 0-inbox/ before detail is lost. The hook itself
// returns immediately so compaction is not blocked on the LLM call.
//
// Opt-in: set LEARNING_LOOP_PRECOMPACT_SPIKE=1 in the environment.

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { emitJson } from './lib/io.mjs';
import { recordDetachedChild } from './lib/common.mjs';
import { logError } from '../scripts/lib/log.mjs';

async function readStdin() {
  return new Promise((res) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (raw += c));
    process.stdin.on('end', () => res(raw));
    process.stdin.on('error', () => res(raw));
    setTimeout(() => res(raw), 1000);
  });
}

try {
  // eslint-disable-next-line learning-loop/no-process-env-outside-env-module
  if (process.env.LEARNING_LOOP_PRECOMPACT_SPIKE === '1') {
    const raw = await readStdin();
    const payload = raw ? JSON.parse(raw) : {};
    const transcriptPath = payload.transcript_path;
    const sessionId = payload.session_id || 'unknown';
    const trigger = payload.trigger || 'unknown';

    if (transcriptPath) {
      const worker = resolve(import.meta.dirname, 'pre-compact-worker.mjs');
      const child = spawn(process.execPath, [worker, transcriptPath, sessionId, trigger], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      recordDetachedChild(child.pid);
    }
  }
} catch (err) {
  logError('hooks/pre-compact', err);
}

emitJson({});
