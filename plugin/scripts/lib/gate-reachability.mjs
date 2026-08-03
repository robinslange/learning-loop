/**
 * Gate reachability check.
 *
 * INJECTION_THRESHOLD is denominated in raw RRF fusion sum, a unit whose scale
 * is set by constants that live in Rust (ll-core lane weights and RRF_K). The
 * JS side cannot see those constants, so a change on the Rust side silently
 * moves the scale out from under the gate. That happened in v1.40.0: weighted
 * fusion dropped the achievable maximum from 0.8333 to 0.4333 while the gate
 * stayed at 0.40, leaving it at 92% of the new ceiling.
 *
 * Mirroring the weights in JS would just move the drift; this checks the
 * OBSERVED distribution instead, so it catches any cause (weight change, RRF_K
 * change, a normalisation added upstream) without knowing which one fired.
 */

/** Fraction of the observed score range that must sit above the gate. */
const MIN_HEADROOM_FRACTION = 0.05;

/** Below this many nonzero observations the verdict is `insufficient-data`. */
const MIN_SAMPLE = 50;

/**
 * Assess whether a gate threshold is reachable against observed top scores.
 *
 * @param {object} input
 * @param {number[]} input.scores  Nonzero top scores from gate evaluations.
 * @param {number} input.threshold The gate value being assessed.
 * @returns {{verdict: 'ok'|'unreachable'|'starved'|'insufficient-data',
 *            observedMax: number, passRate: number, headroom: number,
 *            sample: number, message: string}}
 */
export function assessGateReachability({ scores, threshold }) {
  const nonzero = (scores || []).filter((s) => typeof s === 'number' && s > 0);
  const sample = nonzero.length;

  if (sample < MIN_SAMPLE) {
    return {
      verdict: 'insufficient-data',
      observedMax: sample ? Math.max(...nonzero) : 0,
      passRate: 0,
      headroom: 0,
      sample,
      message: `only ${sample} nonzero gate evaluations; need ${MIN_SAMPLE} to judge reachability`,
    };
  }

  const observedMax = Math.max(...nonzero);
  const passing = nonzero.filter((s) => s >= threshold).length;
  const passRate = passing / sample;
  // Headroom as a fraction of the observed ceiling: how much of the reachable
  // range sits above the gate.
  const headroom = observedMax > 0 ? (observedMax - threshold) / observedMax : 0;

  if (observedMax < threshold) {
    return {
      verdict: 'unreachable',
      observedMax,
      passRate,
      headroom,
      sample,
      message:
        `gate ${threshold} exceeds the highest score ever observed (${observedMax.toFixed(4)}) ` +
        `over ${sample} evaluations: NOTHING can pass. The fusion scale has moved under the gate.`,
    };
  }

  if (headroom < MIN_HEADROOM_FRACTION) {
    return {
      verdict: 'starved',
      observedMax,
      passRate,
      headroom,
      sample,
      message:
        `gate ${threshold} sits within ${(headroom * 100).toFixed(1)}% of the observed ceiling ` +
        `(${observedMax.toFixed(4)}); only ${(passRate * 100).toFixed(1)}% of ${sample} evaluations pass. ` +
        `Re-derive the gate from the current scale.`,
    };
  }

  return {
    verdict: 'ok',
    observedMax,
    passRate,
    headroom,
    sample,
    message:
      `gate ${threshold} passes ${(passRate * 100).toFixed(1)}% of ${sample} nonzero evaluations ` +
      `(observed ceiling ${observedMax.toFixed(4)})`,
  };
}
