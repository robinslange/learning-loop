import { search } from '../../librarian/research/brave.mjs';

async function query(q, opts = {}) {
  if ('apiKey' in opts && !opts.apiKey) return [];
  const results = await search(q, opts);
  return results.map((r) => ({
    url: r.url,
    title: r.title,
    snippet: r.snippet,
    origin: 'web',
    sourceId: 'brave',
  }));
}

export default {
  id: 'brave',
  capabilities: ['query'],
  origin: 'web',
  policy: { returns: 'content' },
  query,
};
