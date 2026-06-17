// plugin/scripts/lib/model-client.mjs : provider-agnostic structured-output chat.
//
// chatJSON() sends one structured-output request and returns the parsed object.
// It normalizes the two provider shapes the librarian targets:
//   - "ollama"  -> POST {base}/api/chat, `format: schema`, reads message.content
//   - "openai"  -> POST {base}/v1/chat/completions (DeepSeek/GLM/Qwen/Fireworks),
//                  `response_format: {type:json_schema}`, bearer auth, reads
//                  choices[0].message.content
// Leaf module (imports nothing internal) so any layer can use it. Network is
// injected via fetchOverride for boundary testing. Throws on HTTP/network error;
// callers that want "never throw" wrap it (as the librarian tools do today).

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * @param {{
 *   provider: { kind: 'ollama'|'openai', baseUrl: string, apiKey?: string },
 *   model: string,
 *   system: string,
 *   user: string,
 *   schema: object,
 *   options?: object,
 *   keepAlive?: string,
 *   timeoutMs?: number,
 *   fetchOverride?: typeof fetch,
 * }} params
 * @returns {Promise<object>} parsed JSON object from the model's response
 */
export async function chatJSON({
  provider,
  model,
  system,
  user,
  schema,
  options,
  keepAlive,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchOverride,
}) {
  const fetchFn = fetchOverride || globalThis.fetch;
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  let url;
  let headers = { 'Content-Type': 'application/json' };
  let body;

  if (provider.kind === 'ollama') {
    url = `${provider.baseUrl}/api/chat`;
    body = { model, messages, format: schema, stream: false };
    if (options !== undefined) body.options = options;
    if (keepAlive !== undefined) body.keep_alive = keepAlive;
  } else if (provider.kind === 'openai') {
    url = `${provider.baseUrl}/v1/chat/completions`;
    if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
    body = {
      model,
      messages,
      response_format: { type: 'json_schema', json_schema: { name: 'response', schema } },
      stream: false,
    };
    // OpenAI-compatible providers don't accept Ollama's `options` bag or `keep_alive`,
    // but sampling params belong at the top level. Lift the ones a caller commonly
    // sets so the same `options:{temperature}` contract is honored on both providers
    // (otherwise a `temperature:0` is silently dropped and the call runs at the
    // server default — a confound for any controlled comparison).
    if (options) {
      for (const k of ['temperature', 'top_p', 'top_k', 'max_tokens', 'seed']) {
        if (options[k] !== undefined) body[k] = options[k];
      }
    }
  } else {
    throw new Error(`unknown provider kind: ${provider.kind}`);
  }

  const res = await fetchFn(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const err = new Error(`${provider.kind} HTTP ${res.status}`);
    err.code = 'MODEL_HTTP_ERROR';
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  const content =
    provider.kind === 'ollama' ? data.message?.content : data.choices?.[0]?.message?.content;
  return JSON.parse(content);
}
