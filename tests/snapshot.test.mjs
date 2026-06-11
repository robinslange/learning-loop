import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const tmpPluginData = mkdtempSync(join(tmpdir(), 'll-snap-pd-'));
const tmpVault = mkdtempSync(join(tmpdir(), 'll-snap-vault-'));

process.env.CLAUDE_PLUGIN_DATA = tmpPluginData;

mkdirSync(join(tmpVault, '0-inbox'), { recursive: true });
mkdirSync(join(tmpVault, '3-permanent'), { recursive: true });
mkdirSync(join(tmpVault, 'Excalidraw'), { recursive: true });
writeFileSync(join(tmpVault, '0-inbox', 'foo.md'), 'inbox foo\n');
writeFileSync(join(tmpVault, '0-inbox', 'ignored.txt'), 'not markdown\n');
writeFileSync(join(tmpVault, '3-permanent', 'bar.md'), 'permanent bar\n');
writeFileSync(join(tmpVault, '3-permanent', 'foo.md'), 'permanent foo\n');
writeFileSync(join(tmpVault, 'Excalidraw', 'diagram.excalidraw.md'), 'diagram\n');

const snapshotPath = join(tmpPluginData, 'vault-snapshot.json');

const mod = await import('../plugin/hooks/lib/snapshot.mjs');
const {
  loadVaultSnapshot,
  rebuildVaultSnapshot,
  maybeSplice,
  removeFromSnapshot,
  buildNoteMapFromSnapshot,
  buildVaultIndexFromSnapshot,
  TTL_MS,
} = mod;

test('rebuild captures all .md files and ignores non-markdown', () => {
  const snap = rebuildVaultSnapshot(tmpVault);
  assert.equal(snap.notes.length, 4);
  const basenames = snap.notes.map((n) => n.basename).sort();
  assert.deepEqual(basenames, ['bar', 'diagram.excalidraw', 'foo', 'foo']);
});

test('buildNoteMapFromSnapshot returns inbox-first for foo.md', () => {
  const snap = loadVaultSnapshot(tmpVault);
  const noteMap = buildNoteMapFromSnapshot(snap, tmpVault);
  assert.equal(noteMap.get('foo.md'), join(tmpVault, '0-inbox', 'foo.md'));
});

test('buildVaultIndexFromSnapshot returns permanent-first for foo', () => {
  const snap = loadVaultSnapshot(tmpVault);
  const idx = buildVaultIndexFromSnapshot(snap);
  assert.equal(idx.get('foo'), '3-permanent/foo.md');
  assert.equal(idx.get('bar'), '3-permanent/bar.md');
});

test('maybeSplice adds new entry; second call returns false', () => {
  const snap = loadVaultSnapshot(tmpVault);
  const newEntry = {
    folder: '0-inbox',
    basename: 'spliced',
    rel_path: '0-inbox/spliced.md',
  };
  assert.equal(maybeSplice(snap, newEntry), true);
  assert.ok(snap.relPathSet.has('0-inbox/spliced.md'));
  assert.equal(maybeSplice(snap, newEntry), false);
  const fresh = JSON.parse(readFileSync(snapshotPath, 'utf-8'));
  assert.ok(fresh.notes.some((n) => n.rel_path === '0-inbox/spliced.md'));
  assert.ok(!('relPathSet' in fresh));
});

test('removeFromSnapshot drops a stale entry', () => {
  const snap = loadVaultSnapshot(tmpVault);
  assert.ok(snap.relPathSet.has('0-inbox/spliced.md'));
  assert.equal(removeFromSnapshot(snap, '0-inbox/spliced.md'), true);
  assert.ok(!snap.relPathSet.has('0-inbox/spliced.md'));
  const fresh = JSON.parse(readFileSync(snapshotPath, 'utf-8'));
  assert.ok(!fresh.notes.some((n) => n.rel_path === '0-inbox/spliced.md'));
});

test('TTL expiry triggers rebuild', () => {
  const snap = loadVaultSnapshot(tmpVault);
  const onDisk = JSON.parse(readFileSync(snapshotPath, 'utf-8'));
  onDisk.expires_at = new Date(Date.now() - 60_000).toISOString();
  writeFileSync(snapshotPath, JSON.stringify(onDisk));
  const reloaded = loadVaultSnapshot(tmpVault);
  assert.ok(Date.parse(reloaded.expires_at) > Date.now());
  assert.ok(Date.parse(reloaded.expires_at) <= Date.now() + TTL_MS + 1000);
  assert.ok(reloaded.notes.length >= 4);
  void snap;
});

test('cleanup temp dirs', () => {
  rmSync(tmpVault, { recursive: true, force: true });
  rmSync(tmpPluginData, { recursive: true, force: true });
});
