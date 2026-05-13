import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEdgeDb, addEdge, saveDb } from '../scripts/lib/edges.mjs';
import {
  runFrontmatterPhase,
  runHeatmapPhase,
  runCyclesPhase,
} from '../scripts/regenerate-viz.mjs';

test('full pipeline writes three artifacts and is idempotent on re-run', async () => {
  const vaultRoot = mkdtempSync(join(tmpdir(), 'll-viz-vault-'));
  mkdirSync(join(vaultRoot, '3-permanent'), { recursive: true });
  mkdirSync(join(vaultRoot, '_system'), { recursive: true });
  const dbDir = mkdtempSync(join(tmpdir(), 'll-viz-db-'));
  const dbPath = join(dbDir, 'edges.db');
  const db = await openEdgeDb(dbPath);

  writeFileSync(join(vaultRoot, '3-permanent', 'alpha.md'), '# Alpha\n');
  writeFileSync(join(vaultRoot, '3-permanent', 'beta.md'), '# Beta\n');
  writeFileSync(join(vaultRoot, '3-permanent', 'gamma.md'), '# Gamma\n');

  addEdge(db, { fromPath: '3-permanent/alpha.md', toPath: '3-permanent/beta.md', edgeType: 'challenges_rebuttal', confidence: 'low', sourceGraph: 'nli', directionFlipped: 0, confidenceScore: 0.96 });
  addEdge(db, { fromPath: '3-permanent/beta.md', toPath: '3-permanent/gamma.md', edgeType: 'challenges_undermining', confidence: 'high', sourceGraph: 'local', directionFlipped: 0 });
  addEdge(db, { fromPath: '3-permanent/gamma.md', toPath: '3-permanent/alpha.md', edgeType: 'challenges_rebuttal', confidence: 'high', sourceGraph: 'local', directionFlipped: 0 });
  saveDb(db, dbPath);

  const c1f = await runFrontmatterPhase(db, vaultRoot, { threshold: 0.95, dryRun: false });
  const c1h = await runHeatmapPhase(db, vaultRoot, { syncThreshold: 0.95, dryRun: false });
  const c1c = await runCyclesPhase(db, vaultRoot, { maxDepth: 4, dryRun: false });

  assert.equal(c1f.updated, 1);
  assert.equal(c1h.rows, 1);
  assert.equal(c1c.cycles, 1);

  const alphaContent1 = readFileSync(join(vaultRoot, '3-permanent', 'alpha.md'), 'utf-8');
  const heatmap1 = readFileSync(join(vaultRoot, '_system', 'nli-conflicts.md'), 'utf-8');
  const canvas1 = readFileSync(join(vaultRoot, '_system', 'viz', 'cycles.canvas'), 'utf-8');

  const c2f = await runFrontmatterPhase(db, vaultRoot, { threshold: 0.95, dryRun: false });
  const c2h = await runHeatmapPhase(db, vaultRoot, { syncThreshold: 0.95, dryRun: false });
  const c2c = await runCyclesPhase(db, vaultRoot, { maxDepth: 4, dryRun: false });

  assert.equal(c2f.updated, 0, 'second run reports zero updates');

  const alphaContent2 = readFileSync(join(vaultRoot, '3-permanent', 'alpha.md'), 'utf-8');
  assert.equal(alphaContent1, alphaContent2, 'frontmatter byte-identical');

  const canvas2 = readFileSync(join(vaultRoot, '_system', 'viz', 'cycles.canvas'), 'utf-8');
  assert.equal(canvas1, canvas2, 'canvas byte-identical');

  const stripTimestamp = (s) => s.replace(/generated:.+/g, 'generated:');
  assert.equal(
    stripTimestamp(heatmap1),
    stripTimestamp(readFileSync(join(vaultRoot, '_system', 'nli-conflicts.md'), 'utf-8')),
  );

  db.close();
  rmSync(vaultRoot, { recursive: true, force: true });
});
