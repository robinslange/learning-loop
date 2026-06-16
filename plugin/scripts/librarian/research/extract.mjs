// plugin/scripts/librarian/research/extract.mjs : local-Gemma claim extraction for research.
//
// EXTRACT_PROMPT and EXTRACT_FORMAT are exported so the model benchmark and the
// pipeline grade/use the same prompt. The extractClaims() runtime function is
// added in a later task.

import { DEFAULT_MODEL, DEFAULT_OLLAMA_URL } from '../../lib/defaults.mjs';
import { chatJSON } from '../../lib/model-client.mjs';

export const EXTRACT_PROMPT = `You extract falsifiable claims from a source document, to answer a research question.

For each claim:
- "claim": one sentence stating something that could be true or false.
- "quote": the exact sentence(s) from the source that support it. Must appear verbatim in the source.
- "importance": "central" (directly answers the question), "supporting" (relevant context), or "tangential".

Also classify the whole source:
- "sourceQuality": "primary" (study/dataset/official), "secondary" (news/review), "blog", "forum", or "unreliable".

If the source is an identifiable academic work (PubMed, journal, arXiv, RFC, or book), also return "sourceId" with its identifier kind, the identifier, and the first author surname and year exactly as printed:
- "sourceId": { "kind": "pmid"|"doi"|"arxiv"|"rfc"|"isbn", "id": "...", "author": "Surname"|null, "year": 2023|null }
If the source is a blog, news article, forum, or any page without a citable identifier, return "sourceId": null. Never guess an identifier.

Extract at most 5 claims. Only claims actually present in the source. Do not invent quotes. If the source has no relevant claims, return an empty claims array.`;

export const EXTRACT_FORMAT = {
  type: 'object',
  required: ['claims', 'sourceQuality'],
  properties: {
    sourceQuality: {
      type: 'string',
      enum: ['primary', 'secondary', 'blog', 'forum', 'unreliable'],
    },
    sourceId: {
      type: ['object', 'null'],
      properties: {
        kind: { type: ['string', 'null'], enum: ['pmid', 'doi', 'arxiv', 'rfc', 'isbn'] },
        id: { type: ['string', 'null'] },
        author: { type: ['string', 'null'] },
        year: { type: ['integer', 'null'] },
      },
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

const EMPTY = { sourceQuality: 'unreliable', sourceId: null, claims: [] };

/**
 * Extract claims from one source's text via structured output. Never throws.
 * Provider-agnostic: pass `provider` to target any model surface, or pass
 * `ollamaUrl`/`model` (back-compat) to synthesize a local Ollama provider.
 * @param {string} text
 * @param {string} question
 * @param {{ provider?: object, ollamaUrl?: string, model?: string, keepAlive?: string, timeoutMs?: number, fetchOverride?: typeof fetch }} [opts]
 * @returns {Promise<{ sourceQuality: string, sourceId: object|null, claims: object[] }>}
 */
export async function extractClaims(text, question, opts = {}) {
  const {
    ollamaUrl = DEFAULT_OLLAMA_URL,
    model = DEFAULT_MODEL,
    keepAlive,
    timeoutMs = 120000,
  } = opts;
  const provider = opts.provider || { kind: 'ollama', baseUrl: ollamaUrl, model };
  try {
    const parsed = await chatJSON({
      provider,
      model: provider.model || model,
      system: EXTRACT_PROMPT,
      user: 'Question: ' + question + '\n\nSource:\n' + text.slice(0, 12000),
      schema: EXTRACT_FORMAT,
      options: { temperature: 0 },
      keepAlive,
      timeoutMs,
      fetchOverride: opts.fetchOverride,
    });
    return {
      sourceQuality: parsed.sourceQuality || 'unreliable',
      sourceId: parsed.sourceId ?? null,
      claims: Array.isArray(parsed.claims) ? parsed.claims : [],
    };
  } catch {
    return { ...EMPTY };
  }
}
