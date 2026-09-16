import { search } from '../../librarian/research/searxng.mjs';

async function query(q, opts = {}) {
  const results = await search(q, opts);
  return results.map((r) => ({
    url: r.url,
    title: r.title,
    snippet: r.snippet,
    origin: 'web',
    sourceId: 'searxng',
  }));
}

export default {
  id: 'searxng',
  capabilities: ['query'],
  origin: 'web',
  policy: { returns: 'content' },
  query,
};
