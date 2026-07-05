import { fetchText } from '../../librarian/research/fetch.mjs';

function fetch(url, opts = {}) {
  return fetchText(url, opts);
}

export default {
  id: 'raw',
  capabilities: ['fetch'],
  origin: 'web',
  policy: { returns: 'content' },
  fetch,
};
