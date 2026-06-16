// plugin/scripts/librarian/research/extract.mjs : local-Gemma claim extraction for research.
//
// EXTRACT_PROMPT and EXTRACT_FORMAT are exported so the model benchmark and the
// pipeline grade/use the same prompt. The extractClaims() runtime function is
// added in a later task.

import { DEFAULT_MODEL, DEFAULT_OLLAMA_URL } from '../../lib/defaults.mjs';

export const EXTRACT_PROMPT = `You extract falsifiable claims from a source document, to answer a research question.

For each claim:
- "claim": one sentence stating something that could be true or false.
- "quote": the exact sentence(s) from the source that support it. Must appear verbatim in the source.
- "importance": "central" (directly answers the question), "supporting" (relevant context), or "tangential".

Also classify the whole source:
- "sourceQuality": "primary" (study/dataset/official), "secondary" (news/review), "blog", "forum", or "unreliable".

Extract at most 5 claims. Only claims actually present in the source. Do not invent quotes. If the source has no relevant claims, return an empty claims array.`;

export const EXTRACT_FORMAT = {
  type: 'object',
  required: ['claims', 'sourceQuality'],
  properties: {
    sourceQuality: {
      type: 'string',
      enum: ['primary', 'secondary', 'blog', 'forum', 'unreliable'],
    },
    claims: {
      type: 'array',
      items: {
        type: 'object',
        required: ['claim', 'quote', 'importance'],
        properties: {
          claim: { type: 'string' },
          quote: { type: 'string' },
          importance: { type: 'string', enum: ['central', 'supporting', 'tangential'] },
        },
      },
    },
  },
};

const EMPTY = { sourceQuality: 'unreliable', claims: [] };

/**
 * Extract claims from one source's text via local Ollama structured output. Never throws.
 * @param {string} text
 * @param {string} question
 * @param {{ ollamaUrl?: string, model?: string, keepAlive?: string, timeoutMs?: number, fetchOverride?: typeof fetch }} [opts]
 * @returns {Promise<{ sourceQuality: string, claims: object[] }>}
 */
export async function extractClaims(text, question, opts = {}) {
  const {
    ollamaUrl = DEFAULT_OLLAMA_URL,
    model = DEFAULT_MODEL,
    keepAlive,
    timeoutMs = 120000,
    fetchOverride,
  } = opts;
  const fetchFn = fetchOverride || globalThis.fetch;
  const body = {
    model,
    messages: [
      { role: 'system', content: EXTRACT_PROMPT },
      {
        role: 'user',
        content: 'Question: ' + question + '\n\nSource:\n' + text.slice(0, 12000),
      },
    ],
    format: EXTRACT_FORMAT,
    options: { temperature: 0 },
    stream: false,
  };
  if (keepAlive !== undefined) body.keep_alive = keepAlive;
  let resp;
  try {
    resp = await fetchFn(`${ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ...EMPTY };
  }
  if (!resp.ok) return { ...EMPTY };
  try {
    const { message } = await resp.json();
    const parsed = JSON.parse(message.content);
    return {
      sourceQuality: parsed.sourceQuality || 'unreliable',
      claims: Array.isArray(parsed.claims) ? parsed.claims : [],
    };
  } catch {
    return { ...EMPTY };
  }
}
