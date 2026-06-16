import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyClaimGlm, VERIFY_PROMPT } from '../plugin/scripts/librarian/verify.mjs';

const provider = { kind: 'openai', baseUrl: 'http://x', apiKey: 'k', model: 'glm' };
const claim = {
  claim: 'ZZZ-distinctive-claim',
  quote: 'q',
  url: 'u',
  sourceUrl: 'u',
  sourceQuality: 'blog',
};

function fetchReturning(verdicts) {
  let i = 0;
  return async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(verdicts[i++]) } }] }),
  });
}

test('survives when fewer than 2 of 3 refute', async () => {
  const r = await verifyClaimGlm('q', claim, {
    provider,
    fetchOverride: fetchReturning([
      { refuted: false, evidence: 'ok', confidence: 'high' },
      { refuted: true, evidence: 'no', confidence: 'low' },
      { refuted: false, evidence: 'ok', confidence: 'medium' },
    ]),
  });
  assert.equal(r.survives, true);
  assert.equal(r.verdicts.length, 3);
  assert.equal(r.mode, 'glm');
});

test('killed when 2 of 3 refute', async () => {
  const r = await verifyClaimGlm('q', claim, {
    provider,
    fetchOverride: fetchReturning([
      { refuted: true, evidence: 'a', confidence: 'high' },
      { refuted: true, evidence: 'b', confidence: 'high' },
      { refuted: false, evidence: 'c', confidence: 'low' },
    ]),
  });
  assert.equal(r.survives, false);
});

test('VERIFY_PROMPT embeds the question and claim', () => {
  const p = VERIFY_PROMPT('the question', claim, 0);
  assert.ok(p.includes('the question'));
  assert.ok(p.includes(claim.claim));
});

test('rejects if any vote fails (whole claim defers to Claude)', async () => {
  await assert.rejects(() =>
    verifyClaimGlm('q', claim, {
      provider,
      fetchOverride: async () => {
        throw new Error('network');
      },
    }),
  );
});
