// scripts/lib/semver.mjs : the one comparator for plain X.Y.Z versions.
//
// Plugin cache dirs, release tags, dependency constraints and the Claude Code
// version check all compare plain X.Y.Z: no prerelease tags or build metadata,
// so no semver library. A component that isn't a number makes the result NaN
// once the comparison reaches it, and NaN fails every `< 0` / `>= 0` / `> 0`
// test. Keep it tight.

export function semverCmp(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
}

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

export function isPlainSemver(s) {
  return SEMVER_RE.test(s);
}
