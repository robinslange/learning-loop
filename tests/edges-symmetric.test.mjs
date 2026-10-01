import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  openEdgeDb,
  addEdge,
  saveDb,
  getDownstreamSymmetric,
  getSoleJustificationDependents,
  getSoleJustificationDependentsSymmetric,
  getEdgesTo,
} from '../plugin/scripts/lib/edges.mjs';

const PLUGIN_DATA = join(
  tmpdir(),
  `ll-test-plugin-data-symmetric-${randomBytes(8).toString('hex')}`,
);
const DB_PATH = join(PLUGIN_DATA, 'edges.db');

describe('symmetric edge queries', () => {
  before(() => mkdirSync(PLUGIN_DATA, { recursive: true }));
  beforeEach(() => {
    if (existsSync(DB_PATH)) rmSync(DB_PATH);
  });
  after(() => rmSync(PLUGIN_DATA, { recursive: true, force: true }));

  it('getDownstreamSymmetric finds nodes via outgoing AND incoming edges', async () => {
    const db = await openEdgeDb(DB_PATH);
    addEdge(db, { fromPath: 'a.md', toPath: 'b.md', edgeType: 'evidence_for' });
    addEdge(db, { fromPath: 'c.md', toPath: 'a.md', edgeType: 'evidence_for' });
    addEdge(db, { fromPath: 'b.md', toPath: 'd.md', edgeType: 'derived_from' });
    saveDb(db, DB_PATH);

    const reachable = getDownstreamSymmetric(db, 'a.md', 5);
    db.close();

    const nodes = new Set(reachable.map((r) => r.node));
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

  it('getSoleJustificationDependentsSymmetric finds sole-dependents when source has multiple unrelated targets', async () => {
    const db = await openEdgeDb(DB_PATH);
    addEdge(db, { fromPath: 'a.md', toPath: 'b.md', edgeType: 'evidence_for' });
    addEdge(db, { fromPath: 'c.md', toPath: 'b.md', edgeType: 'evidence_for' });
    addEdge(db, { fromPath: 'a.md', toPath: 'd.md', edgeType: 'evidence_for' });
    saveDb(db, DB_PATH);

    const dependents = getSoleJustificationDependentsSymmetric(db, 'a.md');
    db.close();

    // a->d is sole (d has only one evidence source)
    // a->b is NOT sole (b has two evidence sources: a and c)
    const soleToPaths = dependents.map((d) => d.to_path).sort();
    assert.deepEqual(soleToPaths, ['d.md']);
  });

  it('getSoleJustificationDependentsSymmetric finds sole-dependents where notePath is the target', async () => {
    const db = await openEdgeDb(DB_PATH);
    addEdge(db, { fromPath: 'a.md', toPath: 'b.md', edgeType: 'evidence_for' });
    addEdge(db, { fromPath: 'a.md', toPath: 'x.md', edgeType: 'evidence_for' });
    saveDb(db, DB_PATH);

    // b has only one source (a), but a also points to x.
    // b's sole-justification is a->b (from b's perspective, a is the only supporter)
    const dependents = getSoleJustificationDependentsSymmetric(db, 'b.md');
    db.close();

    assert.equal(dependents.length, 1);
    assert.equal(dependents[0].from_path, 'a.md');
    assert.equal(dependents[0].to_path, 'b.md');
  });

  it('getSoleJustificationDependentsSymmetric returns both directions at once, and the plain form only the outgoing one', async () => {
    const db = await openEdgeDb(DB_PATH);
    addEdge(db, { fromPath: 'a.md', toPath: 'b.md', edgeType: 'supports' });
    addEdge(db, { fromPath: 'b.md', toPath: 'c.md', edgeType: 'evidence_for' });
    addEdge(db, { fromPath: 'z.md', toPath: 'c.md', edgeType: 'evidence_for' });
    addEdge(db, { fromPath: 'b.md', toPath: 'd.md', edgeType: 'evidence_for' });

    const pairs = (rows) => rows.map((r) => `${r.from_path}>${r.to_path}`).sort();
    const symmetric = pairs(getSoleJustificationDependentsSymmetric(db, 'b.md'));
    const outgoing = pairs(getSoleJustificationDependents(db, 'b.md'));
    db.close();

    // a>b: b is the target and a its only justifier. b>d: b is d's only
    // justifier. b>c is not sole, because z backs c too.
    assert.deepEqual(symmetric, ['a.md>b.md', 'b.md>d.md']);
    assert.deepEqual(outgoing, ['b.md>d.md']);
  });

  it('getEdgesTo returns the incoming edges and none of the outgoing ones', async () => {
    const db = await openEdgeDb(DB_PATH);
    addEdge(db, { fromPath: 'a.md', toPath: 'b.md', edgeType: 'supports' });
    addEdge(db, { fromPath: 'b.md', toPath: 'c.md', edgeType: 'supports' });
    const incoming = getEdgesTo(db, 'b.md').map((r) => `${r.from_path}>${r.to_path}`);
    db.close();
    assert.deepEqual(incoming, ['a.md>b.md']);
  });
});
