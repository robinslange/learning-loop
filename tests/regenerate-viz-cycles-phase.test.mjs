import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEdgeDb, addEdge, saveDb } from '../scripts/lib/edges.mjs';
import { runCyclesPhase } from '../scripts/regenerate-viz.mjs';

test('writes a canvas with one cycle when one exists', async () => {
  const vaultRoot = mkdtempSync(join(tmpdir(), 'll-viz-vault-'));
  mkdirSync(join(vaultRoot, '_system', 'viz'), { recursive: true });
  const dbDir = mkdtempSync(join(tmpdir(), 'll-viz-db-'));
  const dbPath = join(dbDir, 'edges.db');
  const db = await openEdgeDb(dbPath);

  addEdge(db, { fromPath: 'a.md', toPath: 'b.md', edgeType: 'challenges_rebuttal', confidence: 'low', sourceGraph: 'nli', directionFlipped: 0, confidenceScore: 0.97 });
  addEdge(db, { fromPath: 'b.md', toPath: 'c.md', edgeType: 'challenges_undermining', confidence: 'high', sourceGraph: 'local', directionFlipped: 0 });
  addEdge(db, { fromPath: 'c.md', toPath: 'a.md', edgeType: 'challenges_rebuttal', confidence: 'high', sourceGraph: 'local', directionFlipped: 0 });
  saveDb(db, dbPath);

  const counts = await runCyclesPhase(db, vaultRoot, { dryRun: false });
  assert.equal(counts.cycles, 1);

  const canvasPath = join(vaultRoot, '_system', 'viz', 'cycles.canvas');
  assert.ok(existsSync(canvasPath));
  const canvas = JSON.parse(readFileSync(canvasPath, 'utf-8'));
  assert.ok(Array.isArray(canvas.nodes));
  assert.ok(Array.isArray(canvas.edges));
  assert.equal(canvas.nodes.filter((n) => n.type === 'file').length, 3);
  assert.equal(canvas.edges.length, 3);
  assert.ok(canvas.edges.some((e) => e.color === '1'));

  db.close();
  rmSync(vaultRoot, { recursive: true, force: true });
});

test('empty state writes a single text node', async () => {
  const vaultRoot = mkdtempSync(join(tmpdir(), 'll-viz-vault-'));
  mkdirSync(join(vaultRoot, '_system', 'viz'), { recursive: true });
  const dbDir = mkdtempSync(join(tmpdir(), 'll-viz-db-'));
  const dbPath = join(dbDir, 'edges.db');
  const db = await openEdgeDb(dbPath);
  saveDb(db, dbPath);

  const counts = await runCyclesPhase(db, vaultRoot, { dryRun: false });
  assert.equal(counts.cycles, 0);

  const canvasPath = join(vaultRoot, '_system', 'viz', 'cycles.canvas');
  assert.ok(existsSync(canvasPath));
  const canvas = JSON.parse(readFileSync(canvasPath, 'utf-8'));
  assert.equal(canvas.nodes.filter((n) => n.type === 'text').length, 1);
  assert.match(canvas.nodes[0].text, /No contradiction cycles detected/);

  db.close();
  rmSync(vaultRoot, { recursive: true, force: true });
});
