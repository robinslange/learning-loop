// tests/download-binary-prune.test.mjs : pruneOldBinaries in
// scripts/download-binary.mjs.
//
// GitHub issue #22: plugin data bin/ accumulates multiple ll-search binary
// versions/leftovers (65M measured). pruneOldBinaries removes everything in
// bin/ that looks like a stale ll-search artifact and is not the binary just
// installed, without touching .version.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const MOD_PATH = fileURLToPath(new URL('../plugin/scripts/download-binary.mjs', import.meta.url));

test('pruneOldBinaries: removes a stale binary of a different name, keeps the current one and .version', async () => {
  const { pruneOldBinaries } = await import(MOD_PATH);
  const binDir = mkdtempSync(join(tmpdir(), 'll-dlprune-'));
  try {
    writeFileSync(join(binDir, 'll-search'), 'current binary');
    writeFileSync(join(binDir, 'll-search-darwin-arm64.tar.gz'), 'leftover archive');
    writeFileSync(join(binDir, '.version'), 'v2.2.0\n');
    pruneOldBinaries(binDir, 'll-search');
    assert.deepEqual(readdirSync(binDir).sort(), ['.version', 'll-search']);
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
});

test('pruneOldBinaries: removes a stale directory left by a partial extraction', async () => {
  const { pruneOldBinaries } = await import(MOD_PATH);
  const binDir = mkdtempSync(join(tmpdir(), 'll-dlprune-dir-'));
  try {
    writeFileSync(join(binDir, 'll-search.exe'), 'current binary');
    mkdirSync(join(binDir, 'll-search-old-stuff'), { recursive: true });
    writeFileSync(join(binDir, 'll-search-old-stuff', 'leftover'), 'x');
    pruneOldBinaries(binDir, 'll-search.exe');
    assert.deepEqual(readdirSync(binDir), ['ll-search.exe']);
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
});

test('pruneOldBinaries: leaves unrelated files alone', async () => {
  const { pruneOldBinaries } = await import(MOD_PATH);
  const binDir = mkdtempSync(join(tmpdir(), 'll-dlprune-unrelated-'));
  try {
    writeFileSync(join(binDir, 'll-search'), 'current binary');
    writeFileSync(join(binDir, 'README.txt'), 'not ours');
    pruneOldBinaries(binDir, 'll-search');
    assert.deepEqual(readdirSync(binDir).sort(), ['README.txt', 'll-search']);
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
});
