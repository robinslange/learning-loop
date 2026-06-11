// scripts/librarian/tools/model-prob.mjs : extractModelProb extracted from librarian-tools.mjs.
//
// Scans an Ollama /api/chat logprobs trace for the token that emitted the
// `confidence` enum value, and returns the normalized probability of the emitted
// label across the enum set.

/**
 * Extract the model-calibrated probability for a chosen confidence label.
 *
 * Heuristic: find positions whose top_logprobs alternatives contain BOTH "high"
 * and "review" (tokenized forms allowed); if multiple, take the LAST (closest to
 * the tool-call args, not reasoning). Sum exp(logprob) per enum value, normalize,
 * return P(emitted).
 *
 * @param {object[]} logprobs - Ollama logprobs array from the response.
 * @param {string} chosenLabel - The label the model chose ("high" | "review").
 * @returns {number | null} Probability in [0,1] or null if not computable.
 */
export function extractModelProb(logprobs, chosenLabel) {
  if (!Array.isArray(logprobs) || !logprobs.length) return null;
  if (typeof chosenLabel !== 'string' || !chosenLabel.length) return null;

  const ENUM_VALUES = ['high', 'review'];
  const normalise = (t) => (typeof t === 'string' ? t.trim().toLowerCase() : '');
  const matchesEnum = (tok, val) => {
    const n = normalise(tok);
    if (!n) return false;
    return n === val || n.includes(val);
  };

  let lastIdx = -1;
  for (let i = 0; i < logprobs.length; i++) {
    const entry = logprobs[i];
    const alts = entry && entry.top_logprobs;
    if (!Array.isArray(alts) || !alts.length) continue;
    const hasHigh = alts.some((a) => matchesEnum(a.token, 'high'));
    const hasReview = alts.some((a) => matchesEnum(a.token, 'review'));
    if (hasHigh && hasReview) lastIdx = i;
  }
  if (lastIdx === -1) return null;

  const alts = logprobs[lastIdx].top_logprobs;
  const sums = { high: 0, review: 0 };
  for (const a of alts) {
    if (typeof a.logprob !== 'number') continue;
    const p = Math.exp(a.logprob);
    for (const val of ENUM_VALUES) {
      if (matchesEnum(a.token, val)) {
        sums[val] += p;
        break;
      }
    }
  }
  const total = sums.high + sums.review;
  if (total <= 0) return null;
  const chosen = normalise(chosenLabel);
  const chosenKey =
    ENUM_VALUES.find((v) => chosen === v) || ENUM_VALUES.find((v) => chosen.includes(v));
  if (!chosenKey) return null;
  return sums[chosenKey] / total;
}
