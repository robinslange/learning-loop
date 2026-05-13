import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEdgeDb, addEdge, getAllNliEdgesForHeatmap, saveDb } from '../scripts/lib/edges.mjs';

test('returns all nli rows sorted by confidence_score desc', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-edges-'));
  try {
    const dbPath = join(dir, 'edges.db');
    const db = await openEdgeDb(dbPath);
    addEdge(db, { fromPath: 'a/1.md', toPath: 'a/2.md', edgeType: 'challenges_rebuttal', confidence: 'low', sourceGraph: 'nli', directionFlipped: 0, confidenceScore: 0.91 });
    addEdge(db, { fromPath: 'a/3.md', toPath: 'a/4.md', edgeType: 'challenges_rebuttal', confidence: 'low', sourceGraph: 'nli', directionFlipped: 0, confidenceScore: 0.99 });
    addEdge(db, { fromPath: 'a/5.md', toPath: 'a/6.md', edgeType: 'challenges_rebuttal', confidence: 'low', sourceGraph: 'nli', directionFlipped: 0, confidenceScore: 0.95 });
    saveDb(db, dbPath);
    const rows = getAllNliEdgesForHeatmap(db);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => r.confidenceScore), [0.99, 0.95, 0.91]);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
