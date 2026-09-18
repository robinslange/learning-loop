// A cycle counts as "contradiction-bearing" only if it contains at least one
// edge that actually disputes a claim. Support/entailment-only loops are
// tautologies — interesting graph structure but not what cycle surfacing is
// meant to flag.
function isContradictionEdge(e) {
  return typeof e.edgeType === 'string' && e.edgeType.startsWith('challenges_');
}

function canonicalCycleKey(nodes) {
  let minIdx = 0;
  for (let i = 1; i < nodes.length; i++) {
    if (nodes[i] < nodes[minIdx]) minIdx = i;
  }
  const rotated = nodes.slice(minIdx).concat(nodes.slice(0, minIdx));
  return rotated.join('->');
}

function edgeIdentity(e) {
  return e.id ?? `${e.fromPath}>${e.toPath}:${e.edgeType}`;
}

// Cycles are deduplicated at the node level (one cycle per node sequence, see
// the multi-edge test), so the traversed edge list can hide a parallel
// contradiction edge on the same hop. `contradictions` closes that gap: every
// contradiction edge between consecutive nodes of the cycle, whichever
// parallel edge the DFS happened to walk.
function collectContradictions(adj, nodes, start) {
  const seenIds = new Set();
  const contradictions = [];
  for (let i = 0; i < nodes.length; i++) {
    const to = i + 1 < nodes.length ? nodes[i + 1] : start;
    for (const { to: t, edge } of adj.get(nodes[i]) || []) {
      if (t !== to || !isContradictionEdge(edge)) continue;
      const id = edgeIdentity(edge);
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      contradictions.push(edge);
    }
  }
  return contradictions;
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
          cycles.push({
            nodes: [...path],
            edges: fullEdges,
            contradictions: collectContradictions(adj, path, start),
          });
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
