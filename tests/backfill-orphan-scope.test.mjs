import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { openEdgeDb, addEdge, saveDb, getEdgesFrom } from '../plugin/scripts/lib/edges.mjs';
import { removeOrphanEdges } from '../plugin/scripts/backfill-edges.mjs';

const PLUGIN_DATA = join(tmpdir(), `ll-test-backfill-orphan-${randomBytes(8).toString('hex')}`);
const DB_PATH = join(PLUGIN_DATA, 'edges.db');

async function seed() {
  const db = await openEdgeDb(DB_PATH);
  // Edges originating from notes in several folders.
  addEdge(db, {
    fromPath: '3-permanent/a.md',
    toPath: '3-permanent/b.md',
    edgeType: 'evidence_for',
  });
  addEdge(db, { fromPath: '0-inbox/c.md', toPath: '3-permanent/a.md', edgeType: 'evidence_for' });
  addEdge(db, {
    fromPath: '4-projects/d.md',
    toPath: '3-permanent/b.md',
    edgeType: 'derived_from',
  });
  saveDb(db, DB_PATH);
  return db;
}

describe('backfill-edges orphan removal scope', () => {
  before(() => mkdirSync(PLUGIN_DATA, { recursive: true }));
  beforeEach(() => {
    if (existsSync(DB_PATH)) rmSync(DB_PATH);
  });
  after(() => rmSync(PLUGIN_DATA, { recursive: true, force: true }));

  it('a scoped run (--folder) does NOT delete edges from un-walked folders', async () => {
    const db = await seed();
    // Simulate `--folder 3-permanent`: only 3-permanent notes were walked.
    const walked = new Set(['3-permanent/a.md']);
    const { removed } = removeOrphanEdges(db, walked, { scoped: true });

    assert.equal(removed, 0, 'scoped run must remove nothing');
    assert.equal(
      getEdgesFrom(db, '0-inbox/c.md').length,
      1,
      '0-inbox edge must survive a 3-permanent-scoped run',
    );
    assert.equal(
      getEdgesFrom(db, '4-projects/d.md').length,
      1,
      '4-projects edge must survive a 3-permanent-scoped run',
    );
    db.close();
  });

  it('an unscoped run removes edges whose source note was not walked (genuine orphans)', async () => {
    const db = await seed();
    // Full walk that no longer sees 4-projects/d.md (note deleted from vault).
    const walked = new Set(['3-permanent/a.md', '0-inbox/c.md']);
    const { removed } = removeOrphanEdges(db, walked, { scoped: false });

    assert.equal(removed, 1, 'the one genuine orphan edge is removed');
    assert.equal(getEdgesFrom(db, '4-projects/d.md').length, 0, 'orphan edge removed');
    assert.equal(getEdgesFrom(db, '0-inbox/c.md').length, 1, 'walked note keeps its edge');
    db.close();
  });

  it('archived edges are never removed even on an unscoped run', async () => {
    const db = await openEdgeDb(DB_PATH);
    addEdge(db, {
      fromPath: '9-archive/old.md',
      toPath: '3-permanent/b.md',
      edgeType: 'evidence_for',
      sourceGraph: 'archived',
    });
    saveDb(db, DB_PATH);
    const { removed } = removeOrphanEdges(db, new Set(), { scoped: false });
    assert.equal(removed, 0, 'archived edges are excluded from orphan removal');
    db.close();
  });
});
