// Derive a row's origin from the ll-search `peer:`-prefixed path. The Rust binary
// emits `path: "peer:{peer_id}/{rest}"` for federated hits and parses it back
// internally, so the prefix STAYS on path; Node reads `origin` instead of
// re-sniffing the string. sourceId carries the peer id for peer rows, null local.
export function deriveOrigin(row) {
  const p = row && (row.path || row.note || row.id);
  if (typeof p === 'string' && p.startsWith('peer:')) {
    const rest = p.slice('peer:'.length);
    const peerId = rest.split('/')[0] || null;
    return { origin: 'peer', sourceId: peerId };
  }
  return { origin: 'local', sourceId: null };
}

// Flatten a retrieval payload to its flat row list, across the three shapes the
// ll-search retrieval commands emit: a bare array, { results: [...] }, and
// reflect-scan's { queries: [{ results: [...] }] }. Returns [] for anything else.
export function flattenRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.results)) return payload.results;
  if (payload && Array.isArray(payload.queries)) {
    return payload.queries.flatMap((q) => (q && Array.isArray(q.results) ? q.results : []));
  }
  return [];
}
