// tests/model-client.test.mjs : provider-agnostic chatJSON() at the network boundary.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chatJSON } from '../plugin/scripts/lib/model-client.mjs';

const SCHEMA = {
  type: 'object',
  required: ['label'],
  properties: { label: { type: 'string', enum: ['claim', 'topic'] } },
};

// Capture the outgoing request and return a canned response.
function captureFetch(responseBody, status = 200) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body), headers: init.headers || {} });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => responseBody,
    };
  };
  fn.calls = calls;
  return fn;
}

describe('chatJSON — ollama provider', () => {
  const provider = { kind: 'ollama', baseUrl: 'http://localhost:11434' };

  it('POSTs to /api/chat with format schema and parses message.content', async () => {
    const fetchOverride = captureFetch({ message: { content: '{"label":"claim"}' } });
    const out = await chatJSON({
      provider,
      model: 'gemma3:12b',
      system: 'sys',
      user: 'usr',
      schema: SCHEMA,
      fetchOverride,
    });
    assert.deepEqual(out, { label: 'claim' });

    const { url, init, body, headers } = fetchOverride.calls[0];
    assert.equal(url, 'http://localhost:11434/api/chat');
    assert.equal(init.method, 'POST');
    assert.equal(headers['Content-Type'], 'application/json');
    assert.equal(body.model, 'gemma3:12b');
    assert.equal(body.stream, false);
    assert.deepEqual(body.format, SCHEMA); // Ollama: `format`
    assert.equal(body.response_format, undefined);
    assert.deepEqual(body.messages, [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ]);
    assert.equal(headers.Authorization, undefined); // local: no auth
  });

  it('includes keep_alive for ollama', async () => {
    const fetchOverride = captureFetch({ message: { content: '{"label":"topic"}' } });
    await chatJSON({
      provider,
      model: 'm',
      system: 's',
      user: 'u',
      schema: SCHEMA,
      keepAlive: '30m',
      fetchOverride,
    });
    assert.equal(fetchOverride.calls[0].body.keep_alive, '30m');
  });

  it('passes options (e.g. temperature) through in the ollama options bag', async () => {
    const fetchOverride = captureFetch({ message: { content: '{"label":"topic"}' } });
    await chatJSON({
      provider,
      model: 'm',
      system: 's',
      user: 'u',
      schema: SCHEMA,
      options: { temperature: 0 },
      fetchOverride,
    });
    assert.deepEqual(fetchOverride.calls[0].body.options, { temperature: 0 });
  });
});

describe('chatJSON — malformed model responses (defensive optional chaining)', () => {
  it('ollama: a response with no message field rejects parsing the (absent) content, not a property-read crash', async () => {
    const provider = { kind: 'ollama', baseUrl: 'http://localhost:11434' };
    const fetchOverride = captureFetch({});
    await assert.rejects(
      () =>
        chatJSON({ provider, model: 'm', system: 's', user: 'u', schema: SCHEMA, fetchOverride }),
      (e) => e instanceof SyntaxError,
    );
  });

  const openaiProvider = { kind: 'openai', baseUrl: 'http://x', apiKey: 'k' };

  it('openai: no choices field rejects the same way', async () => {
    const fetchOverride = captureFetch({});
    await assert.rejects(
      () =>
        chatJSON({
          provider: openaiProvider,
          model: 'm',
          system: 's',
          user: 'u',
          schema: SCHEMA,
          fetchOverride,
        }),
      (e) => e instanceof SyntaxError,
    );
  });

  it('openai: an empty choices array rejects the same way', async () => {
    const fetchOverride = captureFetch({ choices: [] });
    await assert.rejects(
      () =>
        chatJSON({
          provider: openaiProvider,
          model: 'm',
          system: 's',
          user: 'u',
          schema: SCHEMA,
          fetchOverride,
        }),
      (e) => e instanceof SyntaxError,
    );
  });

  it('openai: a choice with no message field rejects the same way', async () => {
    const fetchOverride = captureFetch({ choices: [{}] });
    await assert.rejects(
      () =>
        chatJSON({
          provider: openaiProvider,
          model: 'm',
          system: 's',
          user: 'u',
          schema: SCHEMA,
          fetchOverride,
        }),
      (e) => e instanceof SyntaxError,
    );
  });
});

describe('chatJSON — openai provider', () => {
  const provider = {
    kind: 'openai',
    baseUrl: 'https://api.fireworks.ai/inference',
    apiKey: 'sk-test',
  };

  it('POSTs to /v1/chat/completions with response_format and bearer auth, parses choices[0]', async () => {
    const fetchOverride = captureFetch({
      choices: [{ message: { content: '{"label":"claim"}' } }],
    });
    const out = await chatJSON({
      provider,
      model: 'accounts/fireworks/models/glm-5p2',
      system: 'sys',
      user: 'usr',
      schema: SCHEMA,
      fetchOverride,
    });
    assert.deepEqual(out, { label: 'claim' });

    const { url, body, headers } = fetchOverride.calls[0];
    assert.equal(url, 'https://api.fireworks.ai/inference/v1/chat/completions');
    assert.equal(body.model, 'accounts/fireworks/models/glm-5p2');
    assert.equal(body.stream, false);
    assert.equal(body.format, undefined); // not Ollama-shaped
    assert.equal(body.response_format.type, 'json_schema'); // OpenAI: response_format
    assert.equal(body.response_format.json_schema.name, 'response');
    assert.deepEqual(body.response_format.json_schema.schema, SCHEMA);
    assert.equal(headers.Authorization, 'Bearer sk-test');
  });

  it('sends no Authorization header when the provider has no apiKey', async () => {
    const fetchOverride = captureFetch({
      choices: [{ message: { content: '{"label":"topic"}' } }],
    });
    await chatJSON({
      provider: { kind: 'openai', baseUrl: 'https://api.fireworks.ai/inference' },
      model: 'm',
      system: 's',
      user: 'u',
      schema: SCHEMA,
      fetchOverride,
    });
    assert.equal(fetchOverride.calls[0].headers.Authorization, undefined);
  });

  it('lifts every sampling param the caller sets, and no others, to the openai body top level', async () => {
    const fetchOverride = captureFetch({
      choices: [{ message: { content: '{"label":"topic"}' } }],
    });
    await chatJSON({
      provider,
      model: 'm',
      system: 's',
      user: 'u',
      schema: SCHEMA,
      options: { temperature: 0.4, top_p: 0.9, top_k: 40, max_tokens: 512, seed: 7 },
      fetchOverride,
    });
    const { body } = fetchOverride.calls[0];
    assert.equal(body.temperature, 0.4);
    assert.equal(body.top_p, 0.9);
    assert.equal(body.top_k, 40);
    assert.equal(body.max_tokens, 512);
    assert.equal(body.seed, 7);
  });

  it('drops keep_alive for openai (not a valid field)', async () => {
    const fetchOverride = captureFetch({
      choices: [{ message: { content: '{"label":"topic"}' } }],
    });
    await chatJSON({
      provider,
      model: 'm',
      system: 's',
      user: 'u',
      schema: SCHEMA,
      keepAlive: '30m',
      fetchOverride,
    });
    assert.equal(fetchOverride.calls[0].body.keep_alive, undefined);
  });

  it("lifts options.temperature to the openai body top-level (so a 0 isn't silently dropped)", async () => {
    const fetchOverride = captureFetch({
      choices: [{ message: { content: '{"label":"topic"}' } }],
    });
    await chatJSON({
      provider,
      model: 'm',
      system: 's',
      user: 'u',
      schema: SCHEMA,
      options: { temperature: 0 },
      fetchOverride,
    });
    assert.equal(fetchOverride.calls[0].body.temperature, 0);
    assert.equal(fetchOverride.calls[0].body.options, undefined); // openai doesn't take Ollama's options bag
  });
});

describe('chatJSON — errors', () => {
  const provider = { kind: 'ollama', baseUrl: 'http://localhost:11434' };

  it('throws on non-2xx HTTP, tagged MODEL_HTTP_ERROR with the status', async () => {
    const fetchOverride = captureFetch({}, 500);
    await assert.rejects(
      () =>
        chatJSON({ provider, model: 'm', system: 's', user: 'u', schema: SCHEMA, fetchOverride }),
      (e) => {
        assert.match(e.message, /HTTP 500/);
        assert.equal(e.code, 'MODEL_HTTP_ERROR');
        assert.equal(e.status, 500);
        return true;
      },
    );
  });

  it('throws on unknown provider kind', async () => {
    await assert.rejects(
      () =>
        chatJSON({
          provider: { kind: 'bedrock', baseUrl: 'x' },
          model: 'm',
          system: 's',
          user: 'u',
          schema: SCHEMA,
          fetchOverride: captureFetch({}),
        }),
      /unknown provider kind/i,
    );
  });
});
