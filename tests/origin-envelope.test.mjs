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

test('counts rows across a reflect-scan {queries:[{results}]} payload', () => {
  const raw = {
    queries: [
      { query: 'q1', results: [{ path: 'a.md' }, { path: 'peer:t/b.md' }] },
      { query: 'q2', results: [{ path: 'c.md' }] },
    ],
  };
  const env = wrapRetrieval(raw);
  assert.equal(env.local_count, 2);
  assert.equal(env.peer_count, 1);
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

test('pointers guard strips content/text from a peer row, keeps local rows and pointer fields', () => {
  const raw = {
    results: [
      { path: 'local.md', score: 0.9, content: 'local body stays' },
      { path: 'peer:thomas/b.md', score: 0.8, title: 'B', content: 'SECRET peer body', text: 'more body' },
    ],
  };
  const env = wrapRetrieval(raw);
  assert.equal(env.results.results[0].content, 'local body stays');
  const peerRow = env.results.results[1];
  assert.equal(peerRow.path, 'peer:thomas/b.md');
  assert.equal(peerRow.title, 'B');
  assert.equal(peerRow.score, 0.8);
  assert.equal('content' in peerRow, false);
  assert.equal('text' in peerRow, false);
  assert.equal(env.peer_count, 1);
  assert.equal(env.local_count, 1);
});

test('pointers guard is a no-op on content-free rows (existing verbatim contract holds)', () => {
  const raw = { results: [{ path: 'a.md', score: 0.9 }, { path: 'peer:x/b.md', score: 0.8 }] };
  const env = wrapRetrieval(raw);
  assert.deepEqual(env.results, raw);
});

test('pointers guard drops an unknown body field a future binary might add (allowlist)', () => {
  const raw = {
    results: [{ path: 'peer:thomas/b.md', score: 0.8, title: 'B', snippet: 'SECRET match context' }],
  };
  const env = wrapRetrieval(raw);
  const peerRow = env.results.results[0];
  assert.equal('snippet' in peerRow, false);
  assert.equal(peerRow.path, 'peer:thomas/b.md');
  assert.equal(peerRow.title, 'B');
  assert.equal(peerRow.score, 0.8);
});
