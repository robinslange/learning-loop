import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openEdgeDb,
  addEdge,
  removeOutgoingEdges,
  removeOutgoingNliEdges,
  saveDb,
} from '../plugin/scripts/lib/edges.mjs';

test('removeOutgoingNliEdges deletes only source_graph=nli rows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-edges-'));
  try {
    const dbPath = join(dir, 'edges.db');
    const db = await openEdgeDb(dbPath);
    addEdge(db, {
      fromPath: 'a.md',
      toPath: 'b.md',
      edgeType: 'supports',
      confidence: 'high',
      sourceGraph: 'local',
      directionFlipped: 0,
    });
    addEdge(db, {
      fromPath: 'a.md',
      toPath: 'c.md',
      edgeType: 'challenges_rebuttal',
      confidence: 'low',
      sourceGraph: 'nli',
      directionFlipped: 0,
      confidenceScore: 0.97,
    });
    addEdge(db, {
      fromPath: 'a.md',
      toPath: 'd.md',
      edgeType: 'evidence_for',
      confidence: 'high',
      sourceGraph: 'local',
      directionFlipped: 0,
    });
    saveDb(db, dbPath);
    removeOutgoingNliEdges(db, 'a.md');
    const remaining = db.exec(
      "SELECT to_path, source_graph FROM edges WHERE from_path = 'a.md' ORDER BY to_path",
    )[0].values;
    assert.equal(remaining.length, 2);
    assert.deepEqual(
      remaining.map((r) => [r[0], r[1]]),
      [
        ['b.md', 'local'],
        ['d.md', 'local'],
      ],
    );
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('removeOutgoingNliEdges is a no-op when no nli edges exist', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-edges-'));
  try {
    const dbPath = join(dir, 'edges.db');
    const db = await openEdgeDb(dbPath);
    addEdge(db, {
      fromPath: 'a.md',
      toPath: 'b.md',
      edgeType: 'supports',
      confidence: 'high',
      sourceGraph: 'local',
      directionFlipped: 0,
    });
    saveDb(db, dbPath);
    removeOutgoingNliEdges(db, 'a.md');
    const remaining = db.exec('SELECT COUNT(*) FROM edges')[0].values[0][0];
    assert.equal(remaining, 1);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
