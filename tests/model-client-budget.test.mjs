import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chatJSON } from '../plugin/scripts/lib/model-client.mjs';

const provider = {
  kind: 'openai',
  baseUrl: 'http://m',
  apiKey: 'k',
  price: { input: 1e-6, output: 2e-6 },
};
const reply = {
  choices: [{ message: { content: '{"ok":true}' } }],
  usage: { prompt_tokens: 5, completion_tokens: 3 },
};

describe('chatJSON budget', () => {
  it('routes the OpenAI request through budget.llm, with the capped request and the provider price', async () => {
    let seenReq, seenPrice;
    const budget = {
      llm: async (call, req, o) => {
        seenPrice = o.price;
        return call({ ...req, max_tokens: 7 });
      },
    };
    const fetchOverride = async (_url, init) => {
      seenReq = JSON.parse(init.body);
      return new Response(JSON.stringify(reply));
    };
    assert.deepEqual(
      await chatJSON({
        provider,
        model: 'x',
        system: 's',
        user: 'u',
        schema: {},
        fetchOverride,
        budget,
      }),
      { ok: true },
    );
    assert.equal(seenReq.max_tokens, 7);
    assert.deepEqual(seenPrice, provider.price);
  });
  it('is unchanged without a budget', async () => {
    const fetchOverride = async () => new Response(JSON.stringify(reply));
    assert.deepEqual(
      await chatJSON({ provider, model: 'x', system: 's', user: 'u', schema: {}, fetchOverride }),
      { ok: true },
    );
  });
});
