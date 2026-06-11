import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEdgeDb } from '../plugin/scripts/lib/edges.mjs';
import { initSQL } from '../plugin/scripts/lib/sqljs.mjs';

const OLD_SCHEMA = `
CREATE TABLE edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_path TEXT NOT NULL,
  to_path TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  confidence TEXT NOT NULL DEFAULT 'high',
  source_graph TEXT DEFAULT 'local',
  direction_flipped INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

async function writePreV119Fixture(dbPath) {
  const SQL = await initSQL();
  const db = new SQL.Database();
  db.run(OLD_SCHEMA);
  db.run(
    "INSERT INTO edges (from_path, to_path, edge_type, confidence, source_graph, direction_flipped) VALUES ('a.md', 'b.md', 'supports', 'high', 'local', 0)",
  );
  db.run(
    "INSERT INTO edges (from_path, to_path, edge_type, confidence, source_graph, direction_flipped) VALUES ('b.md', 'c.md', 'challenges_rebuttal', 'medium', 'local', 1)",
  );
  db.run(
    "INSERT INTO edges (from_path, to_path, edge_type, confidence, source_graph, direction_flipped) VALUES ('c.md', 'd.md', 'derived_from', 'low', 'archived', 0)",
  );
  writeFileSync(dbPath, Buffer.from(db.export()));
  db.close();
}

test('edges schema has confidence_score REAL column', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-edges-'));
  try {
    const dbPath = join(dir, 'edges.db');
    const db = await openEdgeDb(dbPath);
    const res = db.exec('PRAGMA table_info(edges)');
    const cols = res[0]?.values || [];
    const names = cols.map((row) => row[1]);
    assert.ok(names.includes('confidence_score'));
    const idx = names.indexOf('confidence_score');
    assert.equal(cols[idx][2], 'REAL');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migration is idempotent on reopened db', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-edges-'));
  try {
    const dbPath = join(dir, 'edges.db');
    let db = await openEdgeDb(dbPath);
    db.close();
    db = await openEdgeDb(dbPath);
    const res = db.exec('PRAGMA table_info(edges)');
    const cols = res[0]?.values || [];
    const names = cols.map((row) => row[1]);
    assert.ok(names.includes('confidence_score'));
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ALTER TABLE migrates pre-v1.19 edges.db (no confidence_score) to current schema', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-edges-'));
  try {
    const dbPath = join(dir, 'edges.db');
    await writePreV119Fixture(dbPath);

    const db = await openEdgeDb(dbPath);

    const colsResult = db.exec('PRAGMA table_info(edges)');
    const colNames = (colsResult[0]?.values || []).map((row) => row[1]);
    assert.ok(
      colNames.includes('confidence_score'),
      'confidence_score column should exist after migration',
    );
    const idx = colNames.indexOf('confidence_score');
    assert.equal(colsResult[0].values[idx][2], 'REAL');

    const rows = db.exec(
      'SELECT from_path, to_path, edge_type, confidence_score FROM edges ORDER BY id',
    );
    assert.equal(rows[0].values.length, 3, 'pre-existing rows should survive migration');
    for (const row of rows[0].values) {
      assert.equal(row[3], null, 'pre-migration rows should have NULL confidence_score');
    }
    assert.equal(rows[0].values[0][0], 'a.md');
    assert.equal(rows[0].values[0][1], 'b.md');
    assert.equal(rows[0].values[0][2], 'supports');

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('re-opening migrated db is idempotent (data + schema intact)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-edges-'));
  try {
    const dbPath = join(dir, 'edges.db');
    await writePreV119Fixture(dbPath);

    let db = await openEdgeDb(dbPath);
    const { saveDb } = await import('../plugin/scripts/lib/edges.mjs');
    saveDb(db, dbPath);
    db.close();

    db = await openEdgeDb(dbPath);
    const colNames = (db.exec('PRAGMA table_info(edges)')[0]?.values || []).map((row) => row[1]);
    assert.ok(colNames.includes('confidence_score'));

    const rows = db.exec('SELECT COUNT(*) FROM edges');
    assert.equal(rows[0].values[0][0], 3, 'rows should still be intact after second open');

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openEdgeDb is a no-op on db that already has confidence_score', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-edges-'));
  try {
    const dbPath = join(dir, 'edges.db');

    const SQL = await initSQL();
    const seed = new SQL.Database();
    seed.run(`
      CREATE TABLE edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_path TEXT NOT NULL,
        to_path TEXT NOT NULL,
        edge_type TEXT NOT NULL,
        confidence TEXT NOT NULL DEFAULT 'high',
        source_graph TEXT DEFAULT 'local',
        direction_flipped INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        confidence_score REAL
      );
    `);
    seed.run(
      "INSERT INTO edges (from_path, to_path, edge_type, confidence, source_graph, direction_flipped, confidence_score) VALUES ('x.md', 'y.md', 'nli_supports', 'low', 'nli', 0, 0.93)",
    );
    writeFileSync(dbPath, Buffer.from(seed.export()));
    seed.close();

    const db = await openEdgeDb(dbPath);
    const rows = db.exec('SELECT from_path, to_path, confidence_score FROM edges');
    assert.equal(rows[0].values.length, 1);
    assert.equal(rows[0].values[0][0], 'x.md');
    assert.equal(rows[0].values[0][2], 0.93, 'confidence_score should be preserved (no overwrite)');

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
