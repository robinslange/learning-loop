import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEdgeDb, addEdge, saveDb } from '../scripts/lib/edges.mjs';
import { runHeatmapPhase } from '../scripts/regenerate-viz.mjs';

test('writes sorted markdown table to _system/nli-conflicts.md', async () => {
  const vaultRoot = mkdtempSync(join(tmpdir(), 'll-viz-vault-'));
  mkdirSync(join(vaultRoot, '_system'), { recursive: true });
  const dbDir = mkdtempSync(join(tmpdir(), 'll-viz-db-'));
  const dbPath = join(dbDir, 'edges.db');
  const db = await openEdgeDb(dbPath);

  addEdge(db, { fromPath: '3-permanent/a.md', toPath: '3-permanent/b.md', edgeType: 'challenges_rebuttal', confidence: 'low', sourceGraph: 'nli', directionFlipped: 0, confidenceScore: 0.92 });
  addEdge(db, { fromPath: '3-permanent/c.md', toPath: '3-permanent/d.md', edgeType: 'challenges_rebuttal', confidence: 'low', sourceGraph: 'nli', directionFlipped: 0, confidenceScore: 0.98 });
  saveDb(db, dbPath);

  const counts = await runHeatmapPhase(db, vaultRoot, { syncThreshold: 0.95, dryRun: false });
  assert.equal(counts.rows, 2);

  const heatmapPath = join(vaultRoot, '_system', 'nli-conflicts.md');
  assert.ok(existsSync(heatmapPath));
  const content = readFileSync(heatmapPath, 'utf-8');

  assert.match(content, /^---\n[\s\S]*?\n---\n/);
  assert.match(content, /# NLI conflicts/);
  assert.match(content, /\| Source \| Target \| p\(contradict\) \| Created \|/);

  const idx98 = content.indexOf('0.98');
  const idx92 = content.indexOf('0.92');
  assert.ok(idx98 > 0 && idx92 > 0 && idx98 < idx92);

  const rowBelow = content.split('\n').find((l) => l.includes('0.92'));
  assert.match(rowBelow, /below sync threshold/);

  db.close();
  rmSync(vaultRoot, { recursive: true, force: true });
});

test('empty state writes file with 0 contradictions', async () => {
  const vaultRoot = mkdtempSync(join(tmpdir(), 'll-viz-vault-'));
  mkdirSync(join(vaultRoot, '_system'), { recursive: true });
  const dbDir = mkdtempSync(join(tmpdir(), 'll-viz-db-'));
  const dbPath = join(dbDir, 'edges.db');
  const db = await openEdgeDb(dbPath);
  saveDb(db, dbPath);

  const counts = await runHeatmapPhase(db, vaultRoot, { syncThreshold: 0.95, dryRun: false });
  assert.equal(counts.rows, 0);

  const heatmapPath = join(vaultRoot, '_system', 'nli-conflicts.md');
  assert.ok(existsSync(heatmapPath));
  const content = readFileSync(heatmapPath, 'utf-8');
  assert.match(content, /Total contradictions:\s*0/);

  db.close();
  rmSync(vaultRoot, { recursive: true, force: true });
});

test('skips write when content semantically identical (no mtime churn)', async () => {
  const vaultRoot = mkdtempSync(join(tmpdir(), 'll-viz-vault-'));
  mkdirSync(join(vaultRoot, '_system'), { recursive: true });
  const dbDir = mkdtempSync(join(tmpdir(), 'll-viz-db-'));
  const dbPath = join(dbDir, 'edges.db');
  const db = await openEdgeDb(dbPath);
  addEdge(db, { fromPath: '3-permanent/a.md', toPath: '3-permanent/b.md', edgeType: 'challenges_rebuttal', confidence: 'low', sourceGraph: 'nli', directionFlipped: 0, confidenceScore: 0.98 });
  saveDb(db, dbPath);

  await runHeatmapPhase(db, vaultRoot, { syncThreshold: 0.95, dryRun: false });

  const heatmapPath = join(vaultRoot, '_system', 'nli-conflicts.md');
  const { statSync } = await import('node:fs');
  const mtime1 = statSync(heatmapPath).mtimeMs;

  // Force a small delay so a real write would produce a different mtime
  await new Promise((r) => setTimeout(r, 20));

  await runHeatmapPhase(db, vaultRoot, { syncThreshold: 0.95, dryRun: false });
  const mtime2 = statSync(heatmapPath).mtimeMs;

  assert.equal(mtime1, mtime2, 'second run with identical content should not rewrite the file');

  db.close();
  rmSync(vaultRoot, { recursive: true, force: true });
});
