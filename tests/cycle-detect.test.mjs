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

test('handles dense clique without combinatorial blowup', () => {
  // A 10-node clique: every node has an outgoing challenges_* edge to every other
  // (90 directed edges). At maxDepth=6 the DFS enumerates ~32k canonical cycles.
  // This pins the bounded-time behaviour of the Set-based path-membership check
  // and the canonical-deduplication logic together. If either regresses to an
  // unbounded traversal the wall-clock will blow past 1500ms.
  const N = 10;
  const edges = [];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      if (i === j) continue;
      edges.push({
        fromPath: `n${i}.md`,
        toPath: `n${j}.md`,
        edgeType: 'challenges_rebuttal',
        sourceGraph: 'nli',
      });
    }
  }
  const start = Date.now();
  const cycles = findContradictionCycles(edges, { maxDepth: 6 });
  const elapsed = Date.now() - start;
  assert.ok(cycles.length > 0, 'should find cycles in a dense clique');
  assert.ok(elapsed < 1500, `dense-clique traversal must finish <1500ms (got ${elapsed}ms)`);
});
