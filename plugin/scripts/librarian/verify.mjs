// plugin/scripts/librarian/verify.mjs : GLM 3-vote adversarial verification for one claim.
//
// Mirrors the SKILL.md Verify phase: identical claim, refutation bar (2/3), and schema.
// Check #2 is adapted from WebSearch to parametric recall because GLM has no web tools,
// the only intentional divergence from the Claude prompt. Runs the 3 votes via chatJSON
// against the librarian's resolved provider so the work leaves Claude. If any of the 3
// votes fails (chatJSON throws on HTTP/network error or malformed JSON), the whole call
// rejects, so the CLI exits 1 and the router defers the claim to the Claude fallback
// rather than half-verifying it. (Exit 3 means no GLM provider is configured.)

import { fileURLToPath } from 'node:url';
import { chatJSON } from '../lib/model-client.mjs';
import { loadLibrarianConfig } from './config.mjs';

const VOTES_PER_CLAIM = 3;
const REFUTATIONS_REQUIRED = 2;

export const VERDICT_SCHEMA = {
  type: 'object',
  required: ['refuted', 'evidence', 'confidence'],
  properties: {
    refuted: { type: 'boolean' },
    evidence: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    counterSource: { type: 'string' },
  },
};

export function VERIFY_PROMPT(question, claim, v) {
  return (
    '## Adversarial Claim Verifier (voter ' +
    (v + 1) +
    '/' +
    VOTES_PER_CLAIM +
    ')\n\n' +
    'Be SKEPTICAL. Try to REFUTE this claim. >=' +
    REFUTATIONS_REQUIRED +
    '/' +
    VOTES_PER_CLAIM +
    ' refutations kill it.\n\n' +
    '## Research question\n' +
    question +
    '\n\n' +
    '## Claim under review\n"' +
    claim.claim +
    '"\n\n' +
    '**Source:** ' +
    (claim.sourceUrl || claim.url) +
    ' (' +
    (claim.sourceQuality || 'unreliable') +
    ')\n' +
    '**Supporting quote:** "' +
    claim.quote +
    '"\n\n' +
    '## Checklist\n' +
    '1. Is the claim actually supported by the quote, or is it an overreach/misread?\n' +
    '2. Search your knowledge for contradicting evidence: does any credible source dispute or heavily qualify this?\n' +
    "3. Is the source quality sufficient for the claim's strength? (extraordinary claims need primary sources)\n" +
    '4. Is the claim outdated?\n' +
    '5. Is this a marketing claim / press release / cherry-picked benchmark / forum speculation?\n\n' +
    '**refuted=true** if: unsupported by quote / contradicted / low-quality source for strong claim / outdated / marketing fluff.\n' +
    '**refuted=false** ONLY if: claim is well-supported, current, and source quality matches claim strength.\n' +
    'Default to refuted=true if uncertain.\n\nStructured output only. Evidence MUST be specific.'
  );
}

/**
 * Run 3 GLM votes for one claim. Rejects if any vote fails (caller/CLI maps that to the Claude fallback).
 * @param {string} question
 * @param {{claim:string, quote:string, url?:string, sourceUrl?:string, sourceQuality?:string}} claim
 * @param {{provider:object, keepAlive?:string, timeoutMs?:number, fetchOverride?:Function}} opts
 * @returns {Promise<{claim:string, verdicts:object[], survives:boolean, mode:'glm'}>}
 */
export async function verifyClaimGlm(
  question,
  claim,
  { provider, keepAlive, timeoutMs, fetchOverride },
) {
  const verdicts = await Promise.all(
    Array.from({ length: VOTES_PER_CLAIM }, (_, v) =>
      chatJSON({
        provider,
        model: provider.model,
        system: 'You are an adversarial fact-checker. Structured output only.',
        user: VERIFY_PROMPT(question, claim, v),
        schema: VERDICT_SCHEMA,
        keepAlive,
        timeoutMs,
        fetchOverride,
      }),
    ),
  );
  const refuted = verdicts.filter((x) => x.refuted).length;
  const survives = verdicts.length >= REFUTATIONS_REQUIRED && refuted < REFUTATIONS_REQUIRED;
  return { claim: claim.claim, verdicts, survives, mode: 'glm' };
}

async function readStdin() {
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  return JSON.parse(s);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  readStdin()
    .then(async ({ question, claim }) => {
      const cfg = loadLibrarianConfig();
      if (cfg.provider.kind !== 'openai') {
        console.error('no openai provider configured for GLM verify');
        process.exit(3);
      }
      const r = await verifyClaimGlm(question, claim, {
        provider: cfg.provider,
        keepAlive: cfg.keepAlive,
      });
      console.log(JSON.stringify(r));
      process.exit(0);
    })
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
