// tests/regenerate-viz-heatmap-tiebreaker.test.mjs
//
// Determinism test for the heatmap ORDER BY tail. Two NLI rows with the same
// confidence_score AND the same created_at must still sort deterministically.
// The ORDER BY in getAllNliEdgesForHeatmap (scripts/lib/edges.mjs:271-276) is:
//
//   ORDER BY confidence_score DESC NULLS LAST, created_at DESC,
//            from_path ASC, to_path ASC
//
// If the (from_path, to_path) tail were missing, two ties could sort in
// insertion order — fine on the first run, but a future implementation that
// reuses an edge-id sequence (or a re-ingest from envelopes) could flip the
// order, causing a spurious heatmap rewrite and a churned mtime. Pinning the
// tiebreak shape here makes that regression visible.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEdgeDb, addEdge, saveDb } from '../scripts/lib/edges.mjs';
import { runHeatmapPhase } from '../scripts/regenerate-viz.mjs';

function setupVault() {
  const vaultRoot = mkdtempSync(join(tmpdir(), 'll-viz-vault-tie-'));
  mkdirSync(join(vaultRoot, '_system'), { recursive: true });
  const dbDir = mkdtempSync(join(tmpdir(), 'll-viz-db-tie-'));
  return { vaultRoot, dbPath: join(dbDir, 'edges.db'), dbDir };
}

test('heatmap tiebreak: identical p + created_at sort by from_path ASC then to_path ASC', async () => {
  const { vaultRoot, dbPath, dbDir } = setupVault();
  const db = await openEdgeDb(dbPath);

  // Inject the rows in REVERSE of the expected output order so insertion
  // order can't masquerade as a passing test. After ORDER BY the row with
  // from_path='3-permanent/a.md' must come first.
  const FROZEN_TS = '2026-05-13 10:00:00';

  // INSERT directly so we can pin created_at to a single shared value across
  // both rows — addEdge() uses sqlite's default datetime('now') which yields
  // a per-row timestamp.
  db.run(
    'INSERT INTO edges (from_path, to_path, edge_type, confidence, source_graph, direction_flipped, confidence_score, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      '3-permanent/b.md',
      '3-permanent/c.md',
      'challenges_rebuttal',
      'low',
      'nli',
      0,
      0.98,
      FROZEN_TS,
    ],
  );
  db.run(
    'INSERT INTO edges (from_path, to_path, edge_type, confidence, source_graph, direction_flipped, confidence_score, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      '3-permanent/a.md',
      '3-permanent/z.md',
      'challenges_rebuttal',
      'low',
      'nli',
      0,
      0.98,
      FROZEN_TS,
    ],
  );
  // Third row with the SAME from_path as row 1 ('b.md') but earlier to_path
  // ('a.md') to exercise the to_path ASC tail too.
  db.run(
    'INSERT INTO edges (from_path, to_path, edge_type, confidence, source_graph, direction_flipped, confidence_score, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      '3-permanent/b.md',
      '3-permanent/a.md',
      'challenges_rebuttal',
      'low',
      'nli',
      0,
      0.98,
      FROZEN_TS,
    ],
  );
  saveDb(db, dbPath);

  const counts1 = await runHeatmapPhase(db, vaultRoot, { syncThreshold: 0.95, dryRun: false });
  assert.equal(counts1.rows, 3);

  const heatmapPath = join(vaultRoot, '_system', 'nli-conflicts.md');
  const content1 = readFileSync(heatmapPath, 'utf-8');

  const idxA = content1.indexOf('[[a]]');
  const idxBtoA = content1.indexOf('[[b]] | [[a]]');
  const idxBtoC = content1.indexOf('[[b]] | [[c]]');
  assert.ok(idxA > 0 && idxBtoA > 0 && idxBtoC > 0, 'all three rows must render');

  // from_path ASC: a.md row must precede both b.md rows.
  assert.ok(idxA < idxBtoA, 'a.md row sorts before b.md->a.md (from_path ASC)');
  assert.ok(idxA < idxBtoC, 'a.md row sorts before b.md->c.md (from_path ASC)');
  // Within from_path='b.md', to_path ASC: b->a before b->c.
  assert.ok(idxBtoA < idxBtoC, 'b.md->a.md sorts before b.md->c.md (to_path ASC)');

  // Second run must produce byte-identical content (ignoring the timestamp
  // header), proving the order is stable across query invocations.
  const counts2 = await runHeatmapPhase(db, vaultRoot, { syncThreshold: 0.95, dryRun: false });
  assert.equal(counts2.rows, 3);
  const content2 = readFileSync(heatmapPath, 'utf-8');
  const strip = (s) => s.replace(/^generated:.*$/m, 'generated:');
  assert.equal(strip(content1), strip(content2), 'two runs produce identical row ordering');

  db.close();
  rmSync(vaultRoot, { recursive: true, force: true });
  rmSync(dbDir, { recursive: true, force: true });
});
