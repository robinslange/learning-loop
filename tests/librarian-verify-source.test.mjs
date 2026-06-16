import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyClaimSource } from '../plugin/scripts/librarian/verify-source.mjs';

const claim = { claim: 'c', quote: 'q', url: 'u' };
const deps = (over = {}) => ({
  pubmedVerify: async () => ({
    verified: true,
    issues: [],
    metadata: { firstAuthor: 'Smith', year: 2023 },
  }),
  verifyDoi: async () => ({ verified: true, issues: [], metadata: {} }),
  fetchById: async () => ({ title: 'T' }),
  ...over,
});

test('pmid resolves + author match -> pass/survives', async () => {
  const r = await verifyClaimSource(
    claim,
    { kind: 'pmid', id: '1', author: 'Smith', year: 2023 },
    deps(),
  );
  assert.equal(r.verdict, 'pass');
  assert.equal(r.survives, true);
  assert.equal(r.mode, 'mechanical');
});

test('pmid resolves + author MISMATCH (high severity) -> kill', async () => {
  const r = await verifyClaimSource(
    claim,
    { kind: 'pmid', id: '1', author: 'Jones', year: 2023 },
    deps({
      pubmedVerify: async () => ({
        verified: false,
        issues: [{ type: 'wrong_author', severity: 'high' }],
        metadata: {},
      }),
    }),
  );
  assert.equal(r.verdict, 'kill');
  assert.equal(r.survives, false);
});

test('null author -> pass, author_not_checked issue', async () => {
  const r = await verifyClaimSource(
    claim,
    { kind: 'pmid', id: '1', author: null, year: null },
    deps(),
  );
  assert.equal(r.verdict, 'pass');
  assert.equal(r.survives, true);
  assert.ok(r.issues.some((i) => i.type === 'author_not_checked'));
});

test('unresolved id (not-found / null / transient 5xx) -> DEFER, survives null', async () => {
  const r = await verifyClaimSource(
    claim,
    { kind: 'doi', id: 'bad', author: 'A', year: 2020 },
    deps({
      verifyDoi: async () => ({ verified: false, error: 'DOI not found' }),
    }),
  );
  assert.equal(r.verdict, 'defer');
  assert.equal(r.survives, null);
});

test('arxiv resolves -> pass (resolve-only, no author match)', async () => {
  const r = await verifyClaimSource(
    claim,
    { kind: 'arxiv', id: '2310.06825', author: null, year: null },
    deps(),
  );
  assert.equal(r.verdict, 'pass');
  assert.equal(r.survives, true);
});

test('arxiv does not resolve -> defer (could be down, not a kill)', async () => {
  const r = await verifyClaimSource(
    claim,
    { kind: 'arxiv', id: 'bad', author: null, year: null },
    deps({
      fetchById: async () => null,
    }),
  );
  assert.equal(r.verdict, 'defer');
  assert.equal(r.survives, null);
});

test('resolver throws (true network failure) -> rethrows for CLI exit 1', async () => {
  await assert.rejects(() =>
    verifyClaimSource(
      claim,
      { kind: 'pmid', id: '1', author: 'A', year: 2020 },
      deps({
        pubmedVerify: async () => {
          throw new Error('network');
        },
      }),
    ),
  );
});
