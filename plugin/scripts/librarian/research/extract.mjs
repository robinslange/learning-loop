// plugin/scripts/librarian/research/extract.mjs : local-Gemma claim extraction for research.
//
// EXTRACT_PROMPT and EXTRACT_FORMAT are exported so the model benchmark and the
// pipeline grade/use the same prompt. The extractClaims() runtime function is
// added in a later task.

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
