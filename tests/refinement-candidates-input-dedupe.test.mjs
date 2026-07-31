// Regression: refinement-candidates.mjs iterated its raw input list, which the
// /reflect new-notes marker fills append-only (hooks/modules/reflect-track.mjs
// appends once per Write plus once per hook-chain Edit). A note listed 3x ran
// querySimilar 3x and emitted its whole pair set 3x, so refinement-proposer was
// dispatched the same (new_note, candidate) question repeatedly. Observed live
// 2026-07-31: 25 pairs from 10 distinct ones.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, '..', 'plugin/scripts/refinement-candidates.mjs');

// Two candidates in the refinement band, returned for every query. ll-search
// `similar` emits {path, score} where score = 1 - cos²/2, so a target cosine c
// needs score 1 - c²/2. These land at cos 0.78 and 0.76, inside
// [COSINE_MIN 0.74, COSINE_MAX 0.92].
const cosToScore = (c) => 1 - (c * c) / 2;
const STUB_HITS = JSON.stringify([
  { path: '3-permanent/upstream-one.md', score: cosToScore(0.78) },
  { path: '3-permanent/upstream-two.md', score: cosToScore(0.76) },
]);

function setup(sb) {
  const vault = join(sb, 'vault');
  mkdirSync(join(vault, '0-inbox'), { recursive: true });
  mkdirSync(join(vault, '3-permanent'), { recursive: true });
  for (const n of ['upstream-one', 'upstream-two']) {
    writeFileSync(join(vault, '3-permanent', `${n}.md`), `# ${n}\n\nbody\n`);
  }
  const noteA = join(vault, '0-inbox', 'note-a.md');
  const noteB = join(vault, '0-inbox', 'note-b.md');
  writeFileSync(noteA, '# note a\n\nbody\n');
  writeFileSync(noteB, '# note b\n\nbody\n');

  const pdDir = join(sb, 'plugin-data');
  mkdirSync(join(pdDir, 'bin'), { recursive: true });
  writeFileSync(join(pdDir, 'config.json'), '{}');

  // Stub logs one line per invocation so we can count querySimilar calls.
  const callLog = join(sb, 'calls.log');
  const stub = join(pdDir, 'bin', 'll-search');
  writeFileSync(stub, `#!/bin/sh\necho call >> "${callLog}"\ncat <<'EOF'\n${STUB_HITS}\nEOF\n`);
  chmodSync(stub, 0o755);

  return { vault, pdDir, noteA, noteB, callLog };
}

function run(sb, pdDir, vault, args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf-8',
    env: { PATH: process.env.PATH, HOME: sb, CLAUDE_PLUGIN_DATA: pdDir, VAULT_PATH: vault },
  });
}

test('duplicate input paths produce each (new_note, candidate) pair once', () => {
  if (process.platform === 'win32') return;
  const sb = mkdtempSync(join(tmpdir(), 'll-refc-dedupe-'));
  try {
    const { vault, pdDir, noteA, noteB, callLog } = setup(sb);

    // The shape reflect-track.mjs actually writes: A appears 3x, B twice.
    const r = run(sb, pdDir, vault, [noteA, noteA, noteB, noteA, noteB]);
    assert.equal(r.status, 0, `script failed: ${r.stderr}`);

    const pairs = JSON.parse(r.stdout);
    const keys = pairs.map((p) => `${p.new_note}|${p.candidate}`);
    assert.equal(new Set(keys).size, keys.length, 'every (new_note, candidate) must be unique');
    assert.equal(pairs.length, 4, '2 distinct notes x 2 candidates');

    // One embedding query per distinct note, not per input line.
    const calls = readFileSync(callLog, 'utf-8').trim().split('\n').length;
    assert.equal(calls, 2, 'querySimilar runs once per distinct note');

    // The validator matches decisions to pairs by id; gaps or repeats break it.
    assert.deepEqual(
      pairs.map((p) => p.id),
      [1, 2, 3, 4],
    );
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
});

test('paths differing only by resolution are the same note', () => {
  if (process.platform === 'win32') return;
  const sb = mkdtempSync(join(tmpdir(), 'll-refc-dedupe-rel-'));
  try {
    const { vault, pdDir, noteA } = setup(sb);

    // Same file, three spellings. Dedupe keys on the vault-relative path, so
    // all three collapse.
    const messy = join(vault, '0-inbox', '..', '0-inbox', 'note-a.md');
    const r = run(sb, pdDir, vault, [noteA, messy, `${vault}/0-inbox/note-a.md`]);
    assert.equal(r.status, 0, `script failed: ${r.stderr}`);

    const pairs = JSON.parse(r.stdout);
    assert.equal(pairs.length, 2, 'one note x 2 candidates');
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
});
