// plugin/scripts/librarian/verify-route.mjs : pure decision logic for the Verify router.
//
// The router in skills/research/SKILL.md runs inside the Workflow sandbox and cannot
// import this module, so it inlines the same functions verbatim. This module is the
// tested source of truth; tests/librarian-verify-route.test.mjs exercises it and a
// contract test asserts SKILL.md carries a faithful copy.
//
// Two invariants the whole-system adversarial pass surfaced:
//   1. A verdict/survives is NEVER trusted from a transcribed subagent result; survives
//      is recomputed from the verdicts array (GLM/Claude) or required to be a real
//      boolean (mechanical) before it can short-circuit.
//   2. Verifier *failure* (fewer than quorum valid votes) is INCONCLUSIVE, not a kill.
//      Conflating "the verifier couldn't run" with "the claim was refuted" silently
//      ships well-sourced claims as adversarial refutations.

export const VOTES_PER_CLAIM = 3;
export const REFUTATIONS_REQUIRED = 2;

/**
 * Compute survival from the valid votes only, distinguishing a genuine quorum verdict
 * from "not enough votes to decide". Caller passes votes already filtered of nulls.
 * @param {{refuted?:boolean}[]} validVotes
 * @returns {{survives:boolean|null, inconclusive:boolean}}
 */
export function computeSurvives(validVotes) {
  const votes = validVotes || [];
  if (votes.length < REFUTATIONS_REQUIRED) return { survives: null, inconclusive: true };
  const refuted = votes.filter((v) => v.refuted).length;
  return { survives: refuted < REFUTATIONS_REQUIRED, inconclusive: false };
}

/**
 * Branch 1 (mechanical). Only a recognized verdict (pass|kill) with a real boolean
 * survives may short-circuit; anything else (defer, missing/garbled result, non-zero
 * exit) falls through to GLM. Never silently kills on a malformed result.
 * @param {{exitCode?:number, result?:object}|null} out
 * @returns {{shortCircuit:boolean, survives?:boolean, verdict?:string}}
 */
export function normalizeMechanical(out) {
  const r = out && out.exitCode === 0 ? out.result : null;
  if (r && (r.verdict === 'pass' || r.verdict === 'kill') && typeof r.survives === 'boolean') {
    return { shortCircuit: true, survives: r.survives, verdict: r.verdict };
  }
  return { shortCircuit: false };
}

/**
 * Branch 2 (GLM). Recompute survives from the verdicts array rather than trusting the
 * transcribed survives scalar (the schema permits it to be dropped). A result with no
 * usable verdicts is not ok and routes to the Claude fallback.
 * @param {{exitCode?:number, result?:object}|null} out
 * @returns {{ok:boolean, survives?:boolean, verdicts?:object[], inconclusive?:boolean}}
 */
export function normalizeGlm(out) {
  const r = out && out.exitCode === 0 ? out.result : null;
  const verdicts = (r && r.verdicts) || [];
  if (verdicts.length === 0) return { ok: false };
  const { survives, inconclusive } = computeSurvives(verdicts.filter(Boolean));
  return { ok: true, survives, verdicts, inconclusive };
}

/**
 * Audit comparison. Returns 'inconclusive' when the Claude re-vote could not reach
 * quorum (verifier failure) so it is not mislabelled as a GLM-vs-Claude disagreement;
 * otherwise 'agreed'/'disagreed' against the GLM verdict.
 * @param {boolean} glmSurvives
 * @param {{refuted?:boolean}[]} claudeValidVotes
 * @returns {{status:'agreed'|'disagreed'|'inconclusive', claudeSurvives:boolean|null}}
 */
export function auditOutcome(glmSurvives, claudeValidVotes) {
  const { survives, inconclusive } = computeSurvives(claudeValidVotes);
  if (inconclusive) return { status: 'inconclusive', claudeSurvives: null };
  return { status: glmSurvives === survives ? 'agreed' : 'disagreed', claudeSurvives: survives };
}
