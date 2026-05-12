import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findContradictionCycles } from '../scripts/lib/cycle-detect.mjs';

test('finds a 3-cycle with one contradiction', () => {
  const edges = [
    { fromPath: 'a.md', toPath: 'b.md', edgeType: 'supports', sourceGraph: 'local' },
    { fromPath: 'b.md', toPath: 'c.md', edgeType: 'supports', sourceGraph: 'local' },
    { fromPath: 'c.md', toPath: 'a.md', edgeType: 'challenges_rebuttal', sourceGraph: 'nli' },
  ];
  const cycles = findContradictionCycles(edges, { maxDepth: 4 });
  assert.equal(cycles.length, 1);
  assert.deepEqual(cycles[0].nodes.sort(), ['a.md', 'b.md', 'c.md']);
});

test('finds a 4-cycle with one contradiction', () => {
  const edges = [
    { fromPath: 'a.md', toPath: 'b.md', edgeType: 'supports', sourceGraph: 'local' },
    { fromPath: 'b.md', toPath: 'c.md', edgeType: 'supports', sourceGraph: 'local' },
    { fromPath: 'c.md', toPath: 'd.md', edgeType: 'supports', sourceGraph: 'local' },
    { fromPath: 'd.md', toPath: 'a.md', edgeType: 'challenges_undermining', sourceGraph: 'local' },
  ];
  const cycles = findContradictionCycles(edges, { maxDepth: 4 });
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].nodes.length, 4);
});

test('excludes cycles with no contradiction edge', () => {
  const edges = [
    { fromPath: 'a.md', toPath: 'b.md', edgeType: 'supports', sourceGraph: 'local' },
    { fromPath: 'b.md', toPath: 'c.md', edgeType: 'supports', sourceGraph: 'local' },
    { fromPath: 'c.md', toPath: 'a.md', edgeType: 'supports', sourceGraph: 'local' },
  ];
  const cycles = findContradictionCycles(edges, { maxDepth: 4 });
  assert.equal(cycles.length, 0);
});

test('respects maxDepth', () => {
  const edges = [
    { fromPath: 'a.md', toPath: 'b.md', edgeType: 'supports', sourceGraph: 'local' },
    { fromPath: 'b.md', toPath: 'c.md', edgeType: 'supports', sourceGraph: 'local' },
    { fromPath: 'c.md', toPath: 'd.md', edgeType: 'supports', sourceGraph: 'local' },
    { fromPath: 'd.md', toPath: 'e.md', edgeType: 'supports', sourceGraph: 'local' },
    { fromPath: 'e.md', toPath: 'a.md', edgeType: 'challenges_rebuttal', sourceGraph: 'nli' },
  ];
  assert.equal(findContradictionCycles(edges, { maxDepth: 3 }).length, 0);
  assert.equal(findContradictionCycles(edges, { maxDepth: 5 }).length, 1);
});

test('deduplicates rotations of the same cycle', () => {
  const edges = [
    { fromPath: 'a.md', toPath: 'b.md', edgeType: 'supports', sourceGraph: 'local' },
    { fromPath: 'b.md', toPath: 'c.md', edgeType: 'challenges_rebuttal', sourceGraph: 'nli' },
    { fromPath: 'c.md', toPath: 'a.md', edgeType: 'supports', sourceGraph: 'local' },
  ];
  const cycles = findContradictionCycles(edges, { maxDepth: 4 });
  assert.equal(cycles.length, 1);
});

test('handles hub nodes without combinatorial blowup', () => {
  // A hub with 50 outgoing challenges_* edges to peripheral nodes,
  // each peripheral node points back to the hub forming a 2-cycle.
  // Must complete quickly and find each 2-cycle exactly once (50 cycles total).
  const HUB = 'hub.md';
  const edges = [];
  for (let i = 0; i < 50; i++) {
    const peripheral = `p${i}.md`;
    edges.push({ fromPath: HUB, toPath: peripheral, edgeType: 'challenges_rebuttal', sourceGraph: 'nli' });
    edges.push({ fromPath: peripheral, toPath: HUB, edgeType: 'challenges_rebuttal', sourceGraph: 'nli' });
  }
  const start = Date.now();
  const cycles = findContradictionCycles(edges, { maxDepth: 4 });
  const elapsed = Date.now() - start;
  assert.equal(cycles.length, 50, 'each hub<->peripheral pair forms one canonical 2-cycle');
  assert.ok(elapsed < 200, `hub traversal should complete in <200ms (got ${elapsed}ms)`);
});
