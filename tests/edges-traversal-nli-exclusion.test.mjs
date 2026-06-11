// tests/edges-traversal-nli-exclusion.test.mjs
// Pins the source_graph='nli' exclusion in the traversal helpers and gives
// getSoleJustificationDependents its first coverage. NLI edges are advisory
// write-time inferences; if they leak into downstream traversal or
// sole-justification analysis, /rewrite impact maps over-report.

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
  const dir = mkdtempSync(join(tmpdir(), 'll-edges-nli-'));
  const db = await openEdgeDb(join(dir, 'edges.db'));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

test('getDownstream excludes nli-sourced edges at the root and deeper in the chain', async (t) => {
  const db = await freshDb(t);
  addEdge(db, { fromPath: 'a.md', toPath: 'b.md', edgeType: 'supports' });
  addEdge(db, { fromPath: 'a.md', toPath: 'c.md', edgeType: 'nli_supports', confidence: 'low', sourceGraph: 'nli' });
  addEdge(db, { fromPath: 'b.md', toPath: 'd.md', edgeType: 'nli_supports', confidence: 'low', sourceGraph: 'nli' });

  const rows = getDownstream(db, 'a.md');
  const targets = rows.map((r) => r.to_path);
  assert.deepEqual(targets, ['b.md'], `nli edges must not appear downstream; got ${JSON.stringify(targets)}`);
});

test('getDownstreamSymmetric excludes nli edges in both directions', async (t) => {
  const db = await freshDb(t);
  addEdge(db, { fromPath: 'a.md', toPath: 'b.md', edgeType: 'supports' });
  addEdge(db, { fromPath: 'a.md', toPath: 'c.md', edgeType: 'nli_supports', confidence: 'low', sourceGraph: 'nli' });
  addEdge(db, { fromPath: 'z.md', toPath: 'a.md', edgeType: 'nli_supports', confidence: 'low', sourceGraph: 'nli' });

  const rows = getDownstreamSymmetric(db, 'a.md');
  const nodes = rows.map((r) => r.node);
  assert.deepEqual(nodes, ['b.md'], `nli edges must be invisible to symmetric traversal; got ${JSON.stringify(nodes)}`);
});

test('getSoleJustificationDependents returns the edge when notePath is the only justifier', async (t) => {
  const db = await freshDb(t);
  addEdge(db, { fromPath: 'a.md', toPath: 't.md', edgeType: 'evidence_for' });

  const rows = getSoleJustificationDependents(db, 'a.md');
  assert.equal(rows.length, 1, `expected 1 sole-justification row; got ${JSON.stringify(rows)}`);
  assert.equal(rows[0].to_path, 't.md');
  assert.equal(rows[0].edge_type, 'evidence_for');
});

test('getSoleJustificationDependents excludes targets with a second non-nli justifier', async (t) => {
  const db = await freshDb(t);
  addEdge(db, { fromPath: 'a.md', toPath: 't.md', edgeType: 'evidence_for' });
  addEdge(db, { fromPath: 'x.md', toPath: 't.md', edgeType: 'supports' });

  const rows = getSoleJustificationDependents(db, 'a.md');
  assert.equal(rows.length, 0, `t.md has another justifier; got ${JSON.stringify(rows)}`);
});

test('a second justifier that is nli-sourced does NOT rescue the target — still sole-dependent', async (t) => {
  const db = await freshDb(t);
  addEdge(db, { fromPath: 'a.md', toPath: 't.md', edgeType: 'evidence_for' });
  // Defense-in-depth guard under test: even with edge_type 'supports' (not
  // nli_supports), source_graph='nli' must not count as real justification.
  addEdge(db, { fromPath: 'x.md', toPath: 't.md', edgeType: 'supports', confidence: 'low', sourceGraph: 'nli' });

  const rows = getSoleJustificationDependents(db, 'a.md');
  assert.equal(rows.length, 1, 'an advisory nli edge must not mask sole-dependence');
  assert.equal(rows[0].to_path, 't.md');
});

test('getSoleJustificationDependents ignores non-justifying edge types from notePath', async (t) => {
  const db = await freshDb(t);
  // 'associative' is a valid edge type but is NOT in the function's
  // ('evidence_for', 'supports') justification whitelist.
  addEdge(db, { fromPath: 'a.md', toPath: 't.md', edgeType: 'associative' });

  const rows = getSoleJustificationDependents(db, 'a.md');
  assert.equal(rows.length, 0);
});

test('getSoleJustificationDependents excludes nli-sourced edges from notePath itself', async (t) => {
  const db = await freshDb(t);
  addEdge(db, { fromPath: 'a.md', toPath: 't.md', edgeType: 'supports', confidence: 'low', sourceGraph: 'nli' });

  const rows = getSoleJustificationDependents(db, 'a.md');
  assert.equal(rows.length, 0, 'an nli edge from the note must not register as justification');
});
