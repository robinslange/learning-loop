// tests/edges-archive-outgoing.test.mjs
// Pins archiveOutgoingEdges: /rewrite's ARCHIVE flow and /reflect refinement's
// supersede path stamp a note's frontmatter but never move or overwrite it,
// so its outgoing edges keep participating in live graph traversal unless
// something marks them archived. archiveOutgoingEdges is that something --
// it marks rather than deletes (never touching an edge already archived,
// nli, or comention), so getDownstream stops counting the retired note's
// outgoing edges live while the edge rows themselves survive for history.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  openEdgeDb,
  addEdge,
  archiveOutgoingEdges,
  getEdgesFrom,
  getDownstream,
  saveDb,
} from '../plugin/scripts/lib/edges.mjs';

const CLI = fileURLToPath(new URL('../plugin/scripts/edges-cli.mjs', import.meta.url));

async function freshDb(t) {
  const dir = mkdtempSync(join(tmpdir(), 'll-edges-archive-'));
  const db = await openEdgeDb(join(dir, 'edges.db'));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

test("archiveOutgoingEdges marks a note's outgoing edges source_graph=archived", async (t) => {
  const db = await freshDb(t);
  addEdge(db, { fromPath: 'a.md', toPath: 'b.md', edgeType: 'supports' });
  addEdge(db, { fromPath: 'a.md', toPath: 'c.md', edgeType: 'evidence_for' });

  archiveOutgoingEdges(db, 'a.md');

  const rows = getEdgesFrom(db, 'a.md');
  assert.equal(rows.length, 2, 'edges must still exist, only marked');
  for (const row of rows) {
    assert.equal(row.source_graph, 'archived');
  }
});

test('archiveOutgoingEdges leaves incoming edges (to_path) untouched', async (t) => {
  const db = await freshDb(t);
  addEdge(db, { fromPath: 'x.md', toPath: 'a.md', edgeType: 'supports' });

  archiveOutgoingEdges(db, 'a.md');

  const rows = getEdgesFrom(db, 'x.md');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source_graph, 'local');
});

test("archiveOutgoingEdges never touches an edge already nli or comention (mirrors removeOutgoingEdges' filter)", async (t) => {
  const db = await freshDb(t);
  addEdge(db, {
    fromPath: 'a.md',
    toPath: 'b.md',
    edgeType: 'supports',
    confidence: 'low',
    sourceGraph: 'nli',
  });
  addEdge(db, {
    fromPath: 'a.md',
    toPath: 'c.md',
    edgeType: 'associative',
    confidence: 'low',
    sourceGraph: 'comention',
  });

  archiveOutgoingEdges(db, 'a.md');

  const rows = getEdgesFrom(db, 'a.md');
  const byTarget = Object.fromEntries(rows.map((r) => [r.to_path, r.source_graph]));
  assert.equal(byTarget['b.md'], 'nli', 'an nli edge must stay nli, not become archived');
  assert.equal(byTarget['c.md'], 'comention', 'a comention edge must stay comention');
});

test("a retired note's outgoing edges drop out of getDownstream after archiving", async (t) => {
  const db = await freshDb(t);
  addEdge(db, { fromPath: 'a.md', toPath: 'b.md', edgeType: 'supports' });

  assert.deepEqual(
    getDownstream(db, 'a.md').map((r) => r.to_path),
    ['b.md'],
    'sanity: edge is live before archiving',
  );

  archiveOutgoingEdges(db, 'a.md');

  assert.deepEqual(
    getDownstream(db, 'a.md').map((r) => r.to_path),
    [],
    'archived edges must not appear in downstream traversal',
  );
});

test("edges-cli archive-outgoing marks a note's outgoing edges archived", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'll-archive-outgoing-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const dbPath = join(dir, 'edges.db');
  const db = await openEdgeDb(dbPath);
  addEdge(db, { fromPath: 'a.md', toPath: 'b.md', edgeType: 'supports' });
  saveDb(db, dbPath);
  db.close();

  const child = spawnSync(process.execPath, [CLI, 'archive-outgoing', 'a.md'], {
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dir },
  });
  assert.equal(child.status, 0, child.stderr);
  const parsed = JSON.parse(child.stdout);
  assert.deepEqual(parsed, { ok: true, archived: 'a.md' });

  const reopened = await openEdgeDb(dbPath);
  const rows = getEdgesFrom(reopened, 'a.md');
  reopened.close();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source_graph, 'archived');
});
