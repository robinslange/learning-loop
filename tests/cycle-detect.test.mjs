import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findContradictionCycles } from '../plugin/scripts/lib/cycle-detect.mjs';

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

// ---------------------------------------------------------------------------
// Adversarial cases: pin behaviour on shapes that would otherwise let bugs
// drift in silently (self-loops counted, mutual cycles double-counted,
// multi-edges multiplying counts, disconnected components missed, or
// non-contradiction 2-cycles leaking into the output).
// ---------------------------------------------------------------------------

test('ignores self-loops (cycle length 1 < minDepth of 2)', () => {
  // The DFS guard `path.length >= 2` should drop a -> a even when the edge
  // itself is a contradiction. A self-loop is not a meaningful cycle for the
  // cycle viz / contradiction surface.
  const edges = [
    { fromPath: 'a.md', toPath: 'a.md', edgeType: 'challenges_rebuttal', sourceGraph: 'nli' },
  ];
  const cycles = findContradictionCycles(edges, { maxDepth: 4 });
  assert.equal(cycles.length, 0);
});

test('mutual 2-cycle: a<->b produces exactly ONE cycle, not two', () => {
  // Without canonical-rotation dedupe a 2-cycle is discovered twice (once
  // starting at a, once at b). canonicalCycleKey rotates so the lex-min node
  // leads; both rotations collapse to the same key.
  const edges = [
    { fromPath: 'a.md', toPath: 'b.md', edgeType: 'challenges_rebuttal', sourceGraph: 'nli' },
    { fromPath: 'b.md', toPath: 'a.md', edgeType: 'supports', sourceGraph: 'local' },
  ];
  const cycles = findContradictionCycles(edges, { maxDepth: 4 });
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].nodes.length, 2);
  assert.deepEqual(cycles[0].nodes.sort(), ['a.md', 'b.md']);
});

test('multi-edge same direction does not multiply cycle count', () => {
  // Two parallel a->b edges plus one b->a edge. DFS will close the cycle once
  // per outgoing a->b edge, but canonicalCycleKey collapses the rotations to a
  // single key so the output stays at one cycle.
  const edges = [
    { fromPath: 'a.md', toPath: 'b.md', edgeType: 'challenges_rebuttal', sourceGraph: 'local' },
    { fromPath: 'a.md', toPath: 'b.md', edgeType: 'nli_supports', sourceGraph: 'nli' },
    { fromPath: 'b.md', toPath: 'a.md', edgeType: 'challenges_rebuttal', sourceGraph: 'local' },
  ];
  const cycles = findContradictionCycles(edges, { maxDepth: 4 });
  assert.equal(cycles.length, 1);
  assert.deepEqual(cycles[0].nodes.sort(), ['a.md', 'b.md']);
});

test('disconnected components each surface their own cycle', () => {
  // Two disjoint 3-cycles. Neither component shares a node with the other,
  // so each must be found independently. This pins that the DFS restart loop
  // (one start per adj key) covers every component.
  const edges = [
    { fromPath: 'a.md', toPath: 'b.md', edgeType: 'supports', sourceGraph: 'local' },
    { fromPath: 'b.md', toPath: 'c.md', edgeType: 'supports', sourceGraph: 'local' },
    { fromPath: 'c.md', toPath: 'a.md', edgeType: 'challenges_rebuttal', sourceGraph: 'nli' },
    { fromPath: 'x.md', toPath: 'y.md', edgeType: 'supports', sourceGraph: 'local' },
    { fromPath: 'y.md', toPath: 'z.md', edgeType: 'supports', sourceGraph: 'local' },
    { fromPath: 'z.md', toPath: 'x.md', edgeType: 'challenges_rebuttal', sourceGraph: 'nli' },
  ];
  const cycles = findContradictionCycles(edges, { maxDepth: 4 });
  assert.equal(cycles.length, 2);
  const nodeSets = cycles.map((c) => c.nodes.slice().sort().join(','));
  assert.ok(nodeSets.includes('a.md,b.md,c.md'));
  assert.ok(nodeSets.includes('x.md,y.md,z.md'));
});

test('2-cycle with NO contradiction edge is excluded', () => {
  // Two mutually-supporting notes form a 2-cycle, but the contradiction-edge
  // filter (`fullEdges.some(isContradictionEdge)`) drops it. The cycle viz
  // surfaces tension, not agreement loops.
  const edges = [
    { fromPath: 'a.md', toPath: 'b.md', edgeType: 'supports', sourceGraph: 'local' },
    { fromPath: 'b.md', toPath: 'a.md', edgeType: 'supports', sourceGraph: 'local' },
  ];
  const cycles = findContradictionCycles(edges, { maxDepth: 4 });
  assert.equal(cycles.length, 0);
});
