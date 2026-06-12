// scripts/lib/shadow-gate.mjs — canonical shadow-injection entry
// classification, shared by scripts/review-shadow.mjs (the human review CLI)
// and lib/health-checks/quick.mjs (the /doctor readiness check) so the two
// cannot drift: same healthy definition, same backend-health precondition.

// Below this healthy rate (with at least MIN_TOTAL entries) the logs indicate
// an infrastructure problem; pass rates computed over the surviving entries
// are not evidence about the gate.
export const SHADOW_BACKEND_HEALTH_MIN_RATE = 0.6;
export const SHADOW_BACKEND_HEALTH_MIN_TOTAL = 50;

export function isVaultOk(entry) {
  return !entry?.backends?.vault?.error;
}

export function isEpisodicOk(entry) {
  return !entry?.backends?.episodic?.error;
}

// Healthy = both backends answered and the prompt wasn't fast-path skipped.
// Gate-error entries (e.g. no_vault_path) STAY in the healthy denominator —
// excluding them inflates the pass rate.
export function isHealthy(entry) {
  return !entry?.gate?.fast_path_skip && isVaultOk(entry) && isEpisodicOk(entry);
}

export function isGatePassed(entry) {
  return entry?.gate?.passed === true;
}
