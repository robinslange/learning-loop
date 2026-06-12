import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEdgeDb, addEdge, saveDb } from '../plugin/scripts/lib/edges.mjs';

test('addEdge persists confidence_score when provided', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-edges-'));
  try {
    const dbPath = join(dir, 'edges.db');
    const db = await openEdgeDb(dbPath);
    addEdge(db, {
      fromPath: 'a/1.md',
      toPath: 'a/2.md',
      edgeType: 'challenges_rebuttal',
      confidence: 'low',
      sourceGraph: 'nli',
      directionFlipped: 0,
      confidenceScore: 0.967,
    });
    saveDb(db, dbPath);
    const rows = db.exec('SELECT source_graph, confidence_score FROM edges')[0].values;
    assert.equal(rows.length, 1);
    assert.equal(rows[0][0], 'nli');
    assert.ok(Math.abs(rows[0][1] - 0.967) < 1e-6);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('addEdge defaults confidence_score to null', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-edges-'));
  try {
    const dbPath = join(dir, 'edges.db');
    const db = await openEdgeDb(dbPath);
    addEdge(db, {
      fromPath: 'a/1.md',
      toPath: 'a/2.md',
      edgeType: 'supports',
      confidence: 'high',
      sourceGraph: 'local',
      directionFlipped: 0,
    });
    const rows = db.exec('SELECT confidence_score FROM edges')[0].values;
    assert.equal(rows[0][0], null);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
