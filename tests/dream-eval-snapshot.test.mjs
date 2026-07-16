import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fork, snapshot, restore } from '../plugin/scripts/dream-eval/snapshot.mjs';

test('fork copies a memory dir to an isolated clone', () => {
  const src = mkdtempSync(join(tmpdir(), 'src-'));
  writeFileSync(join(src, 'a.md'), 'alpha');
  const dest = join(mkdtempSync(join(tmpdir(), 'dest-')), 'clone');
  fork(src, dest);
  assert.strictEqual(readFileSync(join(dest, 'a.md'), 'utf8'), 'alpha');
});

test('snapshot then restore round-trips content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'live-'));
  writeFileSync(join(dir, 'b.md'), 'original');
  const snap = snapshot(dir, join(mkdtempSync(join(tmpdir(), 'snap-')), 'snap'));
  writeFileSync(join(dir, 'b.md'), 'mutated');
  restore(snap, dir);
  assert.strictEqual(readFileSync(join(dir, 'b.md'), 'utf8'), 'original');
});
