import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEdgeDb, addEdge, saveDb } from '../scripts/lib/edges.mjs';
import { runCyclesPhase } from '../scripts/regenerate-viz.mjs';

// Seeds 10 independent mutual 2-cycles (a↔b, c↔d, …). Cycle-detect's
// canonical-key dedupe collapses a→b→a and b→a→b to a single cycle, so each
// pair contributes exactly one cycle — 10 pairs → 10 cycles total.
async function seedDbWithTenCycles() {
  const dbDir = mkdtempSync(join(tmpdir(), 'll-maxcycles-db-'));
  const dbPath = join(dbDir, 'edges.db');
  const db = await openEdgeDb(dbPath);

  const pairs = [
    ['a', 'b'],
    ['c', 'd'],
    ['e', 'f'],
    ['g', 'h'],
    ['i', 'j'],
    ['k', 'l'],
    ['m', 'n'],
    ['o', 'p'],
    ['q', 'r'],
    ['s', 't'],
  ];
  for (const [x, y] of pairs) {
    addEdge(db, {
      fromPath: `${x}.md`,
      toPath: `${y}.md`,
      edgeType: 'challenges_rebuttal',
      confidence: 'high',
      sourceGraph: 'local',
      directionFlipped: 0,
    });
    addEdge(db, {
      fromPath: `${y}.md`,
      toPath: `${x}.md`,
      edgeType: 'challenges_rebuttal',
      confidence: 'high',
      sourceGraph: 'local',
      directionFlipped: 0,
    });
  }
  saveDb(db, dbPath);
  return { db, dbDir };
}

function seedVault() {
  const vaultRoot = mkdtempSync(join(tmpdir(), 'll-maxcycles-vault-'));
  mkdirSync(join(vaultRoot, '_system', 'viz'), { recursive: true });
  return vaultRoot;
}

function readCanvas(vaultRoot) {
  const canvasPath = join(vaultRoot, '_system', 'viz', 'cycles.canvas');
  assert.ok(existsSync(canvasPath), `canvas not written at ${canvasPath}`);
  return JSON.parse(readFileSync(canvasPath, 'utf-8'));
}

test('runCyclesPhase caps rendered cycles at maxCycles and emits a truncation notice', async () => {
  const vaultRoot = seedVault();
  const { db, dbDir } = await seedDbWithTenCycles();

  const counts = await runCyclesPhase(db, vaultRoot, { maxCycles: 5, dryRun: false });
  assert.equal(counts.cycles, 5, 'runCyclesPhase should report only the rendered cap');

  const canvas = readCanvas(vaultRoot);
  const fileNodes = canvas.nodes.filter((n) => n.type === 'file');
  assert.equal(fileNodes.length, 10, '5 cycles × 2 nodes each = 10 file nodes rendered');

  const textNodes = canvas.nodes.filter((n) => n.type === 'text');
  assert.equal(textNodes.length, 1, 'exactly one truncation-notice text node expected');
  assert.match(textNodes[0].text, /\+5 more cycles not rendered/);

  // The notice node id must not collide with any cycle node id.
  const allIds = canvas.nodes.map((n) => n.id);
  assert.equal(new Set(allIds).size, allIds.length, 'node ids must be unique');

  db.close();
  rmSync(vaultRoot, { recursive: true, force: true });
  rmSync(dbDir, { recursive: true, force: true });
});

test('runCyclesPhase renders every cycle and omits the notice when under the cap', async () => {
  const vaultRoot = seedVault();
  const { db, dbDir } = await seedDbWithTenCycles();

  const counts = await runCyclesPhase(db, vaultRoot, { maxCycles: 100, dryRun: false });
  assert.equal(counts.cycles, 10);

  const canvas = readCanvas(vaultRoot);
  const fileNodes = canvas.nodes.filter((n) => n.type === 'file');
  assert.equal(fileNodes.length, 20, '10 cycles × 2 nodes each = 20 file nodes rendered');

  const truncationNotices = canvas.nodes.filter(
    (n) => n.type === 'text' && /more cycles not rendered/.test(n.text || ''),
  );
  assert.equal(truncationNotices.length, 0, 'no truncation notice should appear under the cap');

  db.close();
  rmSync(vaultRoot, { recursive: true, force: true });
  rmSync(dbDir, { recursive: true, force: true });
});
