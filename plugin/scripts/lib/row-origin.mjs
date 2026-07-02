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

// Awareness-only guard: a peer/pointers row shares its pointer (path/title/score)
// but never its body. Strip content/text from peer-origin rows before they leave
// the Node boundary. Local rows pass through untouched.
export function stripPointerContent(row) {
  if (deriveOrigin(row).origin !== 'peer') return row;
  if (row == null || typeof row !== 'object') return row;
  if (!('content' in row) && !('text' in row)) return row;
  const { content: _c, text: _t, ...rest } = row;
  return rest;
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
