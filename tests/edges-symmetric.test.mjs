import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  openEdgeDb, addEdge, saveDb,
  getDownstreamSymmetric, getSoleJustificationDependentsSymmetric,
} from '../scripts/lib/edges.mjs';

const PLUGIN_DATA = '/tmp/ll-test-plugin-data-symmetric';
const DB_PATH = join(PLUGIN_DATA, 'edges.db');

describe('symmetric edge queries', () => {
  before(() => mkdirSync(PLUGIN_DATA, { recursive: true }));
  beforeEach(() => { if (existsSync(DB_PATH)) rmSync(DB_PATH); });
  after(() => rmSync(PLUGIN_DATA, { recursive: true, force: true }));

  it('getDownstreamSymmetric finds nodes via outgoing AND incoming edges', async () => {
    const db = await openEdgeDb(DB_PATH);
    addEdge(db, { fromPath: 'a.md', toPath: 'b.md', edgeType: 'evidence_for' });
    addEdge(db, { fromPath: 'c.md', toPath: 'a.md', edgeType: 'evidence_for' });
    addEdge(db, { fromPath: 'b.md', toPath: 'd.md', edgeType: 'derived_from' });
    saveDb(db, DB_PATH);

    const reachable = getDownstreamSymmetric(db, 'a.md', 5);
    db.close();

    const nodes = new Set(reachable.map(r => r.node));
    assert.ok(nodes.has('b.md'), 'should reach b via outgoing a→b');
    assert.ok(nodes.has('c.md'), 'should reach c via incoming c→a');
    assert.ok(nodes.has('d.md'), 'should reach d via b→d after a→b');
  });

  it('getSoleJustificationDependentsSymmetric returns empty when target has multiple evidence sources', async () => {
    const db = await openEdgeDb(DB_PATH);
    addEdge(db, { fromPath: 'a.md', toPath: 'b.md', edgeType: 'evidence_for' });
    addEdge(db, { fromPath: 'c.md', toPath: 'b.md', edgeType: 'evidence_for' });
    saveDb(db, DB_PATH);

    const dependents = getSoleJustificationDependentsSymmetric(db, 'a.md');
    db.close();

    assert.equal(dependents.length, 0, 'b.md has two evidence sources, not sole-dependent');
  });

  it('getSoleJustificationDependentsSymmetric finds sole-evidence relationships', async () => {
    const db = await openEdgeDb(DB_PATH);
    addEdge(db, { fromPath: 'a.md', toPath: 'b.md', edgeType: 'evidence_for' });
    saveDb(db, DB_PATH);

    const dependents = getSoleJustificationDependentsSymmetric(db, 'a.md');
    db.close();

    assert.equal(dependents.length, 1);
    assert.equal(dependents[0].to_path, 'b.md');
  });
});
