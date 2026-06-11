// tests/marker-pairs.test.mjs
// The M1/M2 root cause was never "wrong path constant" — it was that the
// skill's bash inherits $TMPDIR while hook subprocesses don't, so tmpdir()-
// anchored markers diverge across the process boundary. This test pins the
// fix: writer and reader run with DIFFERENT $TMPDIR values and must still
// agree, because the marker is anchored in plugin-data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = new URL('../scripts/marker.mjs', import.meta.url).pathname;
const STOP_HOOK = new URL('../hooks/stop-nudge.js', import.meta.url).pathname;

test('last-reflect stamped under one $TMPDIR suppresses stop-nudge under another', () => {
  const pd = mkdtempSync(join(tmpdir(), 'll-pair-pd-'));
  const writerTmp = mkdtempSync(join(tmpdir(), 'll-pair-wtmp-'));
  const readerTmp = mkdtempSync(join(tmpdir(), 'll-pair-rtmp-'));
  const transcript = join(writerTmp, 'transcript.txt');
  writeFileSync(transcript, Buffer.alloc(60000, 'a'));
  try {
    const w = spawnSync(process.execPath, [CLI, 'stamp', 'last-reflect'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, CLAUDE_PLUGIN_DATA: pd, TMPDIR: writerTmp },
    });
    assert.equal(w.status, 0, w.stderr);

    const r = spawnSync(process.execPath, [STOP_HOOK], {
      encoding: 'utf8',
      input: JSON.stringify({ session_id: 'pair-test', transcript_path: transcript, stop_hook_active: false }),
      env: {
        PATH: process.env.PATH,
        CLAUDE_PLUGIN_DATA: pd,
        TMPDIR: readerTmp,
        HOME: readerTmp,
        USERPROFILE: readerTmp,
      },
      timeout: 8000,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      r.stdout.trim(),
      '',
      'reflect stamp must suppress the nudge across a $TMPDIR boundary',
    );
  } finally {
    for (const d of [pd, writerTmp, readerTmp]) rmSync(d, { recursive: true, force: true });
  }
});
