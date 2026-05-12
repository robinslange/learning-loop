import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEdgeDb, addEdge, getEdgesForCycleDetection, saveDb } from '../scripts/lib/edges.mjs';

test('returns nli + challenges_* edges only (excludes supports/derived_from)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-edges-'));
  try {
    const dbPath = join(dir, 'edges.db');
    const db = await openEdgeDb(dbPath);
    addEdge(db, { fromPath: 'a.md', toPath: 'b.md', edgeType: 'challenges_rebuttal', confidence: 'low', sourceGraph: 'nli', directionFlipped: 0, confidenceScore: 0.97 });
    addEdge(db, { fromPath: 'b.md', toPath: 'c.md', edgeType: 'challenges_undermining', confidence: 'high', sourceGraph: 'local', directionFlipped: 0 });
    addEdge(db, { fromPath: 'c.md', toPath: 'd.md', edgeType: 'supports', confidence: 'high', sourceGraph: 'local', directionFlipped: 0 });
    addEdge(db, { fromPath: 'd.md', toPath: 'e.md', edgeType: 'derived_from', confidence: 'high', sourceGraph: 'local', directionFlipped: 0 });
    saveDb(db, dbPath);
    const rows = getEdgesForCycleDetection(db);
    assert.equal(rows.length, 2);
    const types = rows.map((r) => r.edgeType).sort();
    assert.deepEqual(types, ['challenges_rebuttal', 'challenges_undermining']);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
