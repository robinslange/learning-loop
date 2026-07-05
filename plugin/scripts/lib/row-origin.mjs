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

// Awareness-only guard: a peer/pointers row shares its pointer but never its body.
// Allowlist the known pointer fields the ll-search binary emits (SearchResult:
// path/score/title/mtime, RerankResult adds index, SimilarResult adds tags) plus the
// note/id locator keys deriveOrigin trusts, and drop everything else from peer-origin
// rows before they leave the Node boundary. Allowlist not denylist, so a future
// body-bearing field (snippet/excerpt/...) cannot cross by being unlisted. Local rows
// pass through untouched, and a peer row already carrying only pointer fields returns
// the same reference (verbatim contract for content-free rows).
const POINTER_FIELDS = new Set(['path', 'note', 'id', 'score', 'title', 'mtime', 'index', 'tags']);

export function stripPointerContent(row) {
  if (deriveOrigin(row).origin !== 'peer') return row;
  if (row == null || typeof row !== 'object') return row;
  const extraneous = Object.keys(row).filter((k) => !POINTER_FIELDS.has(k));
  if (extraneous.length === 0) return row;
  const kept = {};
  for (const k of Object.keys(row)) if (POINTER_FIELDS.has(k)) kept[k] = row[k];
  return kept;
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
