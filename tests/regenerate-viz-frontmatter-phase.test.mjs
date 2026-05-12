import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEdgeDb, addEdge, saveDb } from '../scripts/lib/edges.mjs';
import { runFrontmatterPhase } from '../scripts/regenerate-viz.mjs';

function setup() {
  const vaultRoot = mkdtempSync(join(tmpdir(), 'll-viz-vault-'));
  const dbDir = mkdtempSync(join(tmpdir(), 'll-viz-db-'));
  mkdirSync(join(vaultRoot, '3-permanent'), { recursive: true });
  mkdirSync(join(vaultRoot, '_system'), { recursive: true });
  return { vaultRoot, dbPath: join(dbDir, 'edges.db') };
}

test('syncs notes with qualifying NLI edges', async () => {
  const { vaultRoot, dbPath } = setup();
  const noteA = join(vaultRoot, '3-permanent', 'a.md');
  const noteB = join(vaultRoot, '3-permanent', 'b.md');
  writeFileSync(noteA, '# A\n');
  writeFileSync(noteB, '# B\n');

  const db = await openEdgeDb(dbPath);
  addEdge(db, { fromPath: '3-permanent/a.md', toPath: '3-permanent/b.md', edgeType: 'challenges_rebuttal', confidence: 'low', sourceGraph: 'nli', directionFlipped: 0, confidenceScore: 0.97 });
  saveDb(db, dbPath);

  const counts = await runFrontmatterPhase(db, vaultRoot, { threshold: 0.95, dryRun: false });
  assert.equal(counts.updated, 1);
  assert.equal(counts.cleared, 0);
  const aContent = readFileSync(noteA, 'utf-8');
  assert.match(aContent, /nli-contradicts:\s*\["\[\[b\]\]"\]/);
  assert.match(aContent, /has-contradiction: true/);
  db.close();
  rmSync(vaultRoot, { recursive: true, force: true });
});

test('clears notes that no longer qualify', async () => {
  const { vaultRoot, dbPath } = setup();
  const noteA = join(vaultRoot, '3-permanent', 'a.md');
  writeFileSync(noteA, '---\nnli-contradicts: ["[[stale]]"]\nhas-contradiction: true\n---\n\n# A\n');

  const db = await openEdgeDb(dbPath);
  saveDb(db, dbPath);

  const counts = await runFrontmatterPhase(db, vaultRoot, { threshold: 0.95, dryRun: false });
  assert.equal(counts.updated, 0);
  assert.equal(counts.cleared, 1);
  const aContent = readFileSync(noteA, 'utf-8');
  assert.doesNotMatch(aContent, /nli-contradicts/);
  db.close();
  rmSync(vaultRoot, { recursive: true, force: true });
});

test('skips _system notes', async () => {
  const { vaultRoot, dbPath } = setup();
  const sysNote = join(vaultRoot, '_system', 'x.md');
  writeFileSync(sysNote, '# X\n');

  const db = await openEdgeDb(dbPath);
  addEdge(db, { fromPath: '_system/x.md', toPath: '3-permanent/y.md', edgeType: 'challenges_rebuttal', confidence: 'low', sourceGraph: 'nli', directionFlipped: 0, confidenceScore: 0.99 });
  saveDb(db, dbPath);

  const counts = await runFrontmatterPhase(db, vaultRoot, { threshold: 0.95, dryRun: false });
  assert.equal(counts.updated, 0);
  const content = readFileSync(sysNote, 'utf-8');
  assert.doesNotMatch(content, /nli-contradicts/);
  db.close();
  rmSync(vaultRoot, { recursive: true, force: true });
});

test('dryRun makes no writes', async () => {
  const { vaultRoot, dbPath } = setup();
  const noteA = join(vaultRoot, '3-permanent', 'a.md');
  const before = '# A\n';
  writeFileSync(noteA, before);

  const db = await openEdgeDb(dbPath);
  addEdge(db, { fromPath: '3-permanent/a.md', toPath: '3-permanent/b.md', edgeType: 'challenges_rebuttal', confidence: 'low', sourceGraph: 'nli', directionFlipped: 0, confidenceScore: 0.97 });
  saveDb(db, dbPath);

  const counts = await runFrontmatterPhase(db, vaultRoot, { threshold: 0.95, dryRun: true });
  assert.equal(counts.updated, 1);
  assert.equal(readFileSync(noteA, 'utf-8'), before);
  db.close();
  rmSync(vaultRoot, { recursive: true, force: true });
});
