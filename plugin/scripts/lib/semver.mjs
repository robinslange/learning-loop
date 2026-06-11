// scripts/lib/semver.mjs : minimal semver comparator for plugin-cache pruning.
//
// Used by hooks/session-start.js to identify cache directories older than the
// running plugin version. We do NOT use a full semver library: cache dir names
// are always plain X.Y.Z, no prerelease tags or build metadata. Keep it tight.

export function semverCmp(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
}

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

export function isPlainSemver(s) {
  return SEMVER_RE.test(s);
}
