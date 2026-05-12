function isContradictionEdge(e) {
  return (
    e.sourceGraph === 'nli' ||
    (typeof e.edgeType === 'string' && e.edgeType.startsWith('challenges_'))
  );
}

function canonicalCycleKey(nodes) {
  let minIdx = 0;
  for (let i = 1; i < nodes.length; i++) {
    if (nodes[i] < nodes[minIdx]) minIdx = i;
  }
  const rotated = nodes.slice(minIdx).concat(nodes.slice(0, minIdx));
  return rotated.join('->');
}

export function findContradictionCycles(edges, { maxDepth = 4 } = {}) {
  const adj = new Map();
  for (const e of edges) {
    if (!adj.has(e.fromPath)) adj.set(e.fromPath, []);
    adj.get(e.fromPath).push({ to: e.toPath, edge: e });
  }

  const seen = new Set();
  const cycles = [];

  // Invariant: pathSet === new Set(path). Mutations to one MUST be mirrored
  // to the other within the same statement. The Set provides O(1) membership
  // check; the array preserves traversal order for cycle emission.
  function dfs(start, current, path, pathSet, edgesInPath) {
    if (path.length > maxDepth) return;
    const neighbours = adj.get(current) || [];
    for (const { to, edge } of neighbours) {
      if (to === start && path.length >= 2) {
        const fullEdges = [...edgesInPath, edge];
        if (!fullEdges.some(isContradictionEdge)) continue;
        const key = canonicalCycleKey(path);
        if (seen.has(key)) continue;
        seen.add(key);
        cycles.push({ nodes: [...path], edges: fullEdges });
        continue;
      }
      if (pathSet.has(to)) continue;
      path.push(to);
      pathSet.add(to);
      edgesInPath.push(edge);
      dfs(start, to, path, pathSet, edgesInPath);
      path.pop();
      pathSet.delete(to);
      edgesInPath.pop();
    }
  }

  for (const start of adj.keys()) {
    dfs(start, start, [start], new Set([start]), []);
  }
  return cycles;
}
