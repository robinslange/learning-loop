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

  for (const start of adj.keys()) {
    const path = [start];
    const pathSet = new Set([start]);
    const edgesInPath = [];

    // enterNode/leaveNode atomically mutate path + pathSet + edgesInPath.
    // Add new tracked state here, in one place, not at every call site.
    function enterNode(node, edge) {
      path.push(node);
      pathSet.add(node);
      edgesInPath.push(edge);
    }
    function leaveNode() {
      const node = path.pop();
      pathSet.delete(node);
      edgesInPath.pop();
    }

    function dfs(current) {
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
        enterNode(to, edge);
        dfs(to);
        leaveNode();
      }
    }

    dfs(start);
  }

  return cycles;
}
