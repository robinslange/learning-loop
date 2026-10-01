// openEdgeDb maps the 'medium' rows an older classifier wrote onto what the
// classifier writes today: counterpoints (undermining, rebuttal) become high,
// everything else becomes one comention edge per pair, and none where the
// pair already has another edge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEdgeDb, saveDb } from '../plugin/scripts/lib/edges.mjs';
import { initSQL } from '../plugin/scripts/lib/sqljs.mjs';

const ROWS = [
  // [from, to, type, confidence, source_graph, flipped]
  ['a.md', 'b.md', 'challenges_undermining', 'medium', 'local', 1],
  ['a.md', 'c.md', 'challenges_rebuttal', 'medium', 'local', 0],
  ['a.md', 'd.md', 'supports', 'medium', 'local', 1],
  ['e.md', 'f.md', 'evidence_for', 'high', 'local', 0],
  ['e.md', 'f.md', 'evidence_for', 'medium', 'local', 0],
  ['g.md', 'h.md', 'derived_from', 'medium', 'local', 0],
  ['g.md', 'h.md', 'supports', 'medium', 'local', 0],
  ['i.md', 'j.md', 'associative', 'low', 'comention', 0],
  ['i.md', 'j.md', 'challenges_undercutting', 'medium', 'local', 0],
  // A retired note's row keeps its archived source.
  ['k.md', 'l.md', 'supports', 'medium', 'archived', 0],
  // The counterpoint is promoted first, so it is the pair's edge and the
  // supports row beside it is dropped.
  ['m.md', 'n.md', 'supports', 'medium', 'local', 0],
  ['m.md', 'n.md', 'challenges_undermining', 'medium', 'local', 0],
  // An archived row is history: it must not stand in for the pair's live edge.
  ['o.md', 'p.md', 'supports', 'medium', 'archived', 0],
  ['o.md', 'p.md', 'derived_from', 'medium', 'local', 0],
];

async function writeFixture(dbPath) {
  const SQL = await initSQL();
  const db = new SQL.Database();
  db.run(`CREATE TABLE edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_path TEXT NOT NULL,
    to_path TEXT NOT NULL,
    edge_type TEXT NOT NULL,
    confidence TEXT NOT NULL DEFAULT 'high',
    source_graph TEXT DEFAULT 'local',
    direction_flipped INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  for (const row of ROWS) {
    db.run(
      'INSERT INTO edges (from_path, to_path, edge_type, confidence, source_graph, direction_flipped) VALUES (?, ?, ?, ?, ?, ?)',
      row,
    );
  }
  writeFileSync(dbPath, Buffer.from(db.export()));
  db.close();
}

function edges(db) {
  return db
    .exec(
      'SELECT from_path, to_path, edge_type, confidence, source_graph, direction_flipped FROM edges ORDER BY from_path, to_path, id',
    )[0]
    .values.map((r) => r.join(' '));
}

const EXPECTED = [
  'a.md b.md challenges_undermining high local 1',
  'a.md c.md challenges_rebuttal high local 0',
  'a.md d.md associative low comention 0',
  'e.md f.md evidence_for high local 0',
  'g.md h.md associative low comention 0',
  'i.md j.md associative low comention 0',
  'k.md l.md associative low archived 0',
  'm.md n.md challenges_undermining high local 0',
  'o.md p.md associative low archived 0',
  'o.md p.md associative low comention 0',
];

test('openEdgeDb maps every medium row onto what the classifier writes today', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-edges-medium-'));
  try {
    const dbPath = join(dir, 'edges.db');
    await writeFixture(dbPath);
    const db = await openEdgeDb(dbPath);
    try {
      assert.deepEqual(edges(db), EXPECTED);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reopening a migrated db changes nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-edges-medium-'));
  try {
    const dbPath = join(dir, 'edges.db');
    await writeFixture(dbPath);
    let db = await openEdgeDb(dbPath);
    saveDb(db, dbPath);
    db.close();
    db = await openEdgeDb(dbPath);
    try {
      assert.deepEqual(edges(db), EXPECTED);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
