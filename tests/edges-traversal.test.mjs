// tests/edges-traversal.test.mjs
// Pins what the traversal helpers follow and what getSoleJustificationDependents
// counts as justification. A breadth-only edge that leaks into either makes
// /rewrite impact maps over-report.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  openEdgeDb,
  addEdge,
  getDownstream,
  getDownstreamSymmetric,
  getSoleJustificationDependents,
  getContradictionGraphEdges,
} from '../plugin/scripts/lib/edges.mjs';
import { findContradictionCycles } from '../plugin/scripts/lib/cycle-detect.mjs';

async function freshDb(t) {
  // openEdgeDb on a nonexistent path gives an in-memory sql.js db; queries
  // read it directly, so no saveDb roundtrip is needed (unlike the
  // edges-symmetric.test.mjs idiom).
  const dir = mkdtempSync(join(tmpdir(), 'll-edges-traversal-'));
  const db = await openEdgeDb(join(dir, 'edges.db'));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

test('getSoleJustificationDependents returns the edge when notePath is the only justifier', async (t) => {
  const db = await freshDb(t);
  addEdge(db, { fromPath: 'a.md', toPath: 't.md', edgeType: 'evidence_for' });

  const rows = getSoleJustificationDependents(db, 'a.md');
  assert.equal(rows.length, 1, `expected 1 sole-justification row; got ${JSON.stringify(rows)}`);
  assert.equal(rows[0].to_path, 't.md');
  assert.equal(rows[0].edge_type, 'evidence_for');
});

test('getSoleJustificationDependents excludes targets with a second justifier', async (t) => {
  const db = await freshDb(t);
  addEdge(db, { fromPath: 'a.md', toPath: 't.md', edgeType: 'evidence_for' });
  addEdge(db, { fromPath: 'x.md', toPath: 't.md', edgeType: 'supports' });

  const rows = getSoleJustificationDependents(db, 'a.md');
  assert.equal(rows.length, 0, `t.md has another justifier; got ${JSON.stringify(rows)}`);
});

test('getSoleJustificationDependents ignores non-justifying edge types from notePath', async (t) => {
  const db = await freshDb(t);
  // 'associative' is a valid edge type but is NOT in the function's
  // ('evidence_for', 'supports') justification whitelist.
  addEdge(db, { fromPath: 'a.md', toPath: 't.md', edgeType: 'associative' });

  const rows = getSoleJustificationDependents(db, 'a.md');
  assert.equal(rows.length, 0);
});

test('getDownstream and getDownstreamSymmetric exclude comention edges', async (t) => {
  // Co-mention rows exist for graph breadth (ranking), not for impact
  // analysis: a "see also" link must not put a note downstream of a claim.
  const db = await freshDb(t);
  addEdge(db, { fromPath: 'a.md', toPath: 'b.md', edgeType: 'supports' });
  addEdge(db, {
    fromPath: 'a.md',
    toPath: 'c.md',
    edgeType: 'associative',
    confidence: 'low',
    sourceGraph: 'comention',
  });
  addEdge(db, {
    fromPath: 'b.md',
    toPath: 'd.md',
    edgeType: 'associative',
    confidence: 'low',
    sourceGraph: 'comention',
  });
  const down = getDownstream(db, 'a.md');
  assert.deepEqual(
    down.map((e) => e.to_path),
    ['b.md'],
  );
  const sym = getDownstreamSymmetric(db, 'a.md');
  assert.deepEqual(
    sym.map((r) => r.node),
    ['b.md'],
  );
});

// A flipped row was classified with its verb after the link ("[[x]] confirms
// this"), so the linked note is the one arguing. derived_from runs from the
// base to the note built on it. The traversals read every row that way.

test('a counterpoint and its own backlink are one hop, not a contradiction cycle', async (t) => {
  const db = await freshDb(t);
  // c.md: "Challenges [[t]]". t.md: "[[c]] — counter-evidence".
  addEdge(db, { fromPath: 'c.md', toPath: 't.md', edgeType: 'challenges_undermining' });
  addEdge(db, {
    fromPath: 't.md',
    toPath: 'c.md',
    edgeType: 'challenges_rebuttal',
    directionFlipped: 1,
  });
  const edges = getContradictionGraphEdges(db);
  assert.deepEqual(
    edges.map((e) => `${e.fromPath}>${e.toPath}`),
    ['c.md>t.md', 'c.md>t.md'],
  );
  assert.deepEqual(findContradictionCycles(edges), []);
});

test('a note that builds on a note and challenges it is not a cycle', async (t) => {
  const db = await freshDb(t);
  // c.md: "Builds on [[base]]. Challenges [[base]] — it ignores order."
  addEdge(db, { fromPath: 'c.md', toPath: 'base.md', edgeType: 'derived_from' });
  addEdge(db, { fromPath: 'c.md', toPath: 'base.md', edgeType: 'challenges_undermining' });
  assert.deepEqual(findContradictionCycles(getContradictionGraphEdges(db)), []);
});

test('two notes that each challenge the other still form a cycle', async (t) => {
  const db = await freshDb(t);
  addEdge(db, { fromPath: 'a.md', toPath: 'b.md', edgeType: 'challenges_rebuttal' });
  addEdge(db, { fromPath: 'b.md', toPath: 'a.md', edgeType: 'challenges_rebuttal' });
  assert.equal(findContradictionCycles(getContradictionGraphEdges(db)).length, 1);
});

test('getSoleJustificationDependents credits the linked note of a flipped evidence row', async (t) => {
  const db = await freshDb(t);
  // t.md: "[[a]] confirms this".
  addEdge(db, { fromPath: 't.md', toPath: 'a.md', edgeType: 'evidence_for', directionFlipped: 1 });
  assert.deepEqual(
    getSoleJustificationDependents(db, 'a.md').map((r) => `${r.from_path}>${r.to_path}`),
    ['a.md>t.md'],
  );
  assert.deepEqual(getSoleJustificationDependents(db, 't.md'), []);
});

test('a flipped evidence row counts as a second justifier', async (t) => {
  const db = await freshDb(t);
  addEdge(db, { fromPath: 'a.md', toPath: 't.md', edgeType: 'evidence_for' });
  // t.md: "[[x]] supports this".
  addEdge(db, { fromPath: 't.md', toPath: 'x.md', edgeType: 'supports', directionFlipped: 1 });
  assert.deepEqual(getSoleJustificationDependents(db, 'a.md'), []);
});

test('getDownstream reaches the notes built on a note, not the ones it builds on', async (t) => {
  const db = await freshDb(t);
  // b.md: "Builds on [[a]]". c.md: "[[b]] extends this", so b is built on c.
  addEdge(db, { fromPath: 'b.md', toPath: 'a.md', edgeType: 'derived_from' });
  addEdge(db, { fromPath: 'c.md', toPath: 'b.md', edgeType: 'derived_from', directionFlipped: 1 });
  assert.deepEqual(
    getDownstream(db, 'a.md').map((e) => e.to_path),
    ['b.md'],
  );
  assert.deepEqual(
    getDownstream(db, 'c.md').map((e) => e.to_path),
    ['b.md'],
  );
  assert.deepEqual(getDownstream(db, 'b.md'), []);
});

test('getDownstream follows a flipped evidence row from the evidence to the claim', async (t) => {
  const db = await freshDb(t);
  addEdge(db, { fromPath: 't.md', toPath: 'a.md', edgeType: 'evidence_for', directionFlipped: 1 });
  assert.deepEqual(
    getDownstream(db, 'a.md').map((e) => `${e.from_path}>${e.to_path}`),
    ['a.md>t.md'],
  );
  assert.deepEqual(getDownstream(db, 't.md'), []);
});
