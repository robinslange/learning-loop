import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEdgeDb, addEdge, getNliEdgesForNote, saveDb } from '../plugin/scripts/lib/edges.mjs';

test('returns nli edges where note is from_path or to_path above threshold', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-edges-'));
  try {
    const dbPath = join(dir, 'edges.db');
    const db = await openEdgeDb(dbPath);
    addEdge(db, { fromPath: 'a/target.md', toPath: 'a/partner1.md', edgeType: 'challenges_rebuttal', confidence: 'low', sourceGraph: 'nli', directionFlipped: 0, confidenceScore: 0.97 });
    addEdge(db, { fromPath: 'a/partner2.md', toPath: 'a/target.md', edgeType: 'nli_supports', confidence: 'low', sourceGraph: 'nli', directionFlipped: 0, confidenceScore: 0.82 });
    addEdge(db, { fromPath: 'a/target.md', toPath: 'a/partner3.md', edgeType: 'challenges_rebuttal', confidence: 'low', sourceGraph: 'nli', directionFlipped: 0, confidenceScore: 0.62 });
    addEdge(db, { fromPath: 'a/other.md', toPath: 'a/orphan.md', edgeType: 'challenges_rebuttal', confidence: 'low', sourceGraph: 'nli', directionFlipped: 0, confidenceScore: 0.99 });
    saveDb(db, dbPath);
    const rows = getNliEdgesForNote(db, 'a/target.md', 0.75);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].confidenceScore, 0.97);
    assert.equal(rows[0].partner, 'a/partner1.md');
    assert.equal(rows[1].partner, 'a/partner2.md');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('partner field resolves both edge directions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-edges-'));
  try {
    const dbPath = join(dir, 'edges.db');
    const db = await openEdgeDb(dbPath);
    addEdge(db, { fromPath: 'a/me.md', toPath: 'a/you.md', edgeType: 'challenges_rebuttal', confidence: 'low', sourceGraph: 'nli', directionFlipped: 0, confidenceScore: 0.93 });
    addEdge(db, { fromPath: 'a/them.md', toPath: 'a/me.md', edgeType: 'nli_supports', confidence: 'low', sourceGraph: 'nli', directionFlipped: 0, confidenceScore: 0.81 });
    saveDb(db, dbPath);
    const rows = getNliEdgesForNote(db, 'a/me.md', 0.5);
    const partners = rows.map((r) => r.partner).sort();
    assert.deepEqual(partners, ['a/them.md', 'a/you.md']);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('excludes non-nli source_graph edges (peer NLI deferred)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-edges-'));
  try {
    const dbPath = join(dir, 'edges.db');
    const db = await openEdgeDb(dbPath);
    addEdge(db, { fromPath: 'a/me.md', toPath: 'a/local.md', edgeType: 'challenges_rebuttal', confidence: 'high', sourceGraph: 'local', directionFlipped: 0, confidenceScore: 0.99 });
    addEdge(db, { fromPath: 'a/me.md', toPath: 'a/peer.md', edgeType: 'challenges_rebuttal', confidence: 'low', sourceGraph: 'peer:abc', directionFlipped: 0, confidenceScore: 0.96 });
    addEdge(db, { fromPath: 'a/me.md', toPath: 'a/nli.md', edgeType: 'challenges_rebuttal', confidence: 'low', sourceGraph: 'nli', directionFlipped: 0, confidenceScore: 0.91 });
    saveDb(db, dbPath);
    const rows = getNliEdgesForNote(db, 'a/me.md', 0.5);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].partner, 'a/nli.md');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('returns empty when no edges meet threshold', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-edges-'));
  try {
    const dbPath = join(dir, 'edges.db');
    const db = await openEdgeDb(dbPath);
    addEdge(db, { fromPath: 'a/me.md', toPath: 'a/partner.md', edgeType: 'challenges_rebuttal', confidence: 'low', sourceGraph: 'nli', directionFlipped: 0, confidenceScore: 0.60 });
    saveDb(db, dbPath);
    const rows = getNliEdgesForNote(db, 'a/me.md', 0.75);
    assert.equal(rows.length, 0);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('orders results by confidence_score descending', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-edges-'));
  try {
    const dbPath = join(dir, 'edges.db');
    const db = await openEdgeDb(dbPath);
    addEdge(db, { fromPath: 'a/me.md', toPath: 'a/p1.md', edgeType: 'challenges_rebuttal', confidence: 'low', sourceGraph: 'nli', directionFlipped: 0, confidenceScore: 0.82 });
    addEdge(db, { fromPath: 'a/me.md', toPath: 'a/p2.md', edgeType: 'challenges_rebuttal', confidence: 'low', sourceGraph: 'nli', directionFlipped: 0, confidenceScore: 0.97 });
    addEdge(db, { fromPath: 'a/me.md', toPath: 'a/p3.md', edgeType: 'nli_supports', confidence: 'low', sourceGraph: 'nli', directionFlipped: 0, confidenceScore: 0.89 });
    saveDb(db, dbPath);
    const rows = getNliEdgesForNote(db, 'a/me.md', 0.75);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => r.confidenceScore), [0.97, 0.89, 0.82]);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
