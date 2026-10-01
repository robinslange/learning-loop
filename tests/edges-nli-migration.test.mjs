// openEdgeDb removes what the deleted NLI contradiction detector left in an
// edges.db: its edge rows and its two tables. Every install converges on open,
// with no cleanup script to remember.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEdgeDb } from '../plugin/scripts/lib/edges.mjs';
import { initSQL } from '../plugin/scripts/lib/sqljs.mjs';

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
  db.run(
    "INSERT INTO edges (from_path, to_path, edge_type, confidence, source_graph) VALUES ('a.md', 'b.md', 'supports', 'high', 'local'), ('a.md', 'c.md', 'challenges_undermining', 'low', 'nli'), ('c.md', 'a.md', 'supports', 'low', 'nli')",
  );
  // An nli row sharing a pair with a medium row must not cost the pair its
  // co-mention: the nli row goes before the medium dedupe looks at the pair.
  db.run(
    "INSERT INTO edges (from_path, to_path, edge_type, confidence, source_graph) VALUES ('d.md', 'e.md', 'challenges_rebuttal', 'low', 'nli'), ('d.md', 'e.md', 'supports', 'medium', 'local')",
  );
  db.run('CREATE TABLE viz_meta (k TEXT, v TEXT)');
  db.run('CREATE TABLE nli_frontmatter_tags (path TEXT, tag TEXT)');
  writeFileSync(dbPath, Buffer.from(db.export()));
  db.close();
}

test('openEdgeDb deletes nli edges and drops the NLI tables, keeping everything else', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-edges-nli-migration-'));
  try {
    const dbPath = join(dir, 'edges.db');
    await writeFixture(dbPath);
    const db = await openEdgeDb(dbPath);
    try {
      const edges = db
        .exec('SELECT from_path, to_path, source_graph FROM edges ORDER BY from_path, to_path')[0]
        .values.map((r) => r.join(' '));
      const tables = db
        .exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")[0]
        .values.map((r) => r[0]);
      assert.deepEqual(edges, ['a.md b.md local', 'd.md e.md comention']);
      assert.deepEqual(
        tables.filter((t) => t !== 'sqlite_sequence'),
        ['edges', 'supersessions'],
      );
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
