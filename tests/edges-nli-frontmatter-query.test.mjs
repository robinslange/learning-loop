import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEdgeDb, addEdge, getNliEdgesForFrontmatter, saveDb } from '../scripts/lib/edges.mjs';

test('returns only nli edges at or above threshold', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-edges-'));
  try {
    const dbPath = join(dir, 'edges.db');
    const db = await openEdgeDb(dbPath);
    addEdge(db, { fromPath: 'a/1.md', toPath: 'a/2.md', edgeType: 'challenges_rebuttal', confidence: 'low', sourceGraph: 'nli', directionFlipped: 0, confidenceScore: 0.97 });
    addEdge(db, { fromPath: 'a/3.md', toPath: 'a/4.md', edgeType: 'challenges_rebuttal', confidence: 'low', sourceGraph: 'nli', directionFlipped: 0, confidenceScore: 0.92 });
    addEdge(db, { fromPath: 'a/5.md', toPath: 'a/6.md', edgeType: 'supports', confidence: 'high', sourceGraph: 'local', directionFlipped: 0 });
    saveDb(db, dbPath);
    const rows = getNliEdgesForFrontmatter(db, 0.95);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].fromPath, 'a/1.md');
    assert.ok(rows[0].confidenceScore >= 0.95);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('groups multiple targets per source', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-edges-'));
  try {
    const dbPath = join(dir, 'edges.db');
    const db = await openEdgeDb(dbPath);
    addEdge(db, { fromPath: 'a/1.md', toPath: 'a/2.md', edgeType: 'challenges_rebuttal', confidence: 'low', sourceGraph: 'nli', directionFlipped: 0, confidenceScore: 0.97 });
    addEdge(db, { fromPath: 'a/1.md', toPath: 'a/3.md', edgeType: 'challenges_rebuttal', confidence: 'low', sourceGraph: 'nli', directionFlipped: 0, confidenceScore: 0.96 });
    saveDb(db, dbPath);
    const rows = getNliEdgesForFrontmatter(db, 0.95);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.fromPath === 'a/1.md'));
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
