import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrapRetrieval } from '../plugin/scripts/lib/origin-envelope.mjs';

test('wraps retrieval results in an untrusted-data envelope', () => {
  const raw = { results: [{ path: 'a.md', score: 0.9 }] };
  const env = wrapRetrieval(raw);
  assert.equal(env.origin, 'vault-retrieval');
  assert.equal(env.trust, 'untrusted-data');
  assert.match(env.note, /NOT operator instructions/);
  assert.deepEqual(env.results, raw);
});

test('counts local vs peer rows from a flat results array', () => {
  const raw = {
    results: [
      { path: 'a.md', score: 0.9 },
      { path: 'peer:thomas/b.md', score: 0.8 },
    ],
  };
  const env = wrapRetrieval(raw);
  assert.equal(env.local_count, 1);
  assert.equal(env.peer_count, 1);
});

test('handles a bare array payload (rerank returns an array)', () => {
  const raw = [{ path: 'peer:x/c.md' }, { path: 'd.md' }];
  const env = wrapRetrieval(raw);
  assert.equal(env.peer_count, 1);
  assert.equal(env.local_count, 1);
  assert.deepEqual(env.results, raw);
});

test('counts peer rows inside reflect-scan { queries: [{ results }] } shape', () => {
  const raw = {
    queries: [
      { query: 'q1', results: [{ path: 'a.md' }, { path: 'peer:thomas_kirk/b.md' }] },
      { query: 'q2', results: [{ path: 'peer:thomas_kirk/c.md' }] },
    ],
  };
  const env = wrapRetrieval(raw);
  assert.equal(env.peer_count, 2);
  assert.equal(env.local_count, 1);
  assert.deepEqual(env.results, raw); // still verbatim
});
