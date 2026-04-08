import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { openEdgeDb, addEdge, removeOutgoingEdges, getEdgesFrom, getDownstream, saveDb } from '../scripts/lib/edges.mjs';

const PLUGIN_DATA = '/tmp/ll-test-plugin-data-archive';
const DB_PATH = join(PLUGIN_DATA, 'edges.db');

describe('archive edge preservation', () => {
  before(() => mkdirSync(PLUGIN_DATA, { recursive: true }));
  beforeEach(() => { if (existsSync(DB_PATH)) rmSync(DB_PATH); });
  after(() => rmSync(PLUGIN_DATA, { recursive: true, force: true }));

  it('removeOutgoingEdges skips rows where source_graph = archived', async () => {
    const db = await openEdgeDb(DB_PATH);
    addEdge(db, { fromPath: '3-permanent/note-x.md', toPath: '3-permanent/note-y.md', edgeType: 'evidence_for', sourceGraph: 'local' });
    addEdge(db, { fromPath: '3-permanent/note-x.md', toPath: '3-permanent/note-z.md', edgeType: 'derived_from', sourceGraph: 'archived' });
    saveDb(db, DB_PATH);
    db.close();

    const db2 = await openEdgeDb(DB_PATH);
    removeOutgoingEdges(db2, '3-permanent/note-x.md');
    saveDb(db2, DB_PATH);
    const remaining = getEdgesFrom(db2, '3-permanent/note-x.md');
    db2.close();

    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].source_graph, 'archived');
    assert.equal(remaining[0].to_path, '3-permanent/note-z.md');
  });

  it('addEdge accepts source_graph=archived', async () => {
    const db = await openEdgeDb(DB_PATH);
    const id = addEdge(db, {
      fromPath: '3-permanent/a.md', toPath: '3-permanent/b.md',
      edgeType: 'supports', sourceGraph: 'archived',
    });
    saveDb(db, DB_PATH);
    db.close();
    assert.ok(id > 0);
  });

  it('getDownstream excludes archived edges from traversal', async () => {
    const db = await openEdgeDb(DB_PATH);
    addEdge(db, { fromPath: 'a.md', toPath: 'b.md', edgeType: 'evidence_for', sourceGraph: 'local' });
    addEdge(db, { fromPath: 'a.md', toPath: 'c.md', edgeType: 'derived_from', sourceGraph: 'archived' });
    addEdge(db, { fromPath: 'b.md', toPath: 'd.md', edgeType: 'evidence_for', sourceGraph: 'local' });
    saveDb(db, DB_PATH);

    const downstream = getDownstream(db, 'a.md', 5);
    db.close();

    const toPaths = downstream.map(e => e.to_path).sort();
    assert.deepEqual(toPaths, ['b.md', 'd.md'], 'archived edge to c.md must be excluded; b→d chain still reached');
  });
});
