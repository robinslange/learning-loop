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
} from '../plugin/scripts/lib/edges.mjs';

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
