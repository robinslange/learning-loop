/**
 * tests/helpers/published-docs.mjs — what this repository publishes, for the
 * sweeps that check documents against the code.
 *
 * **Defined by what it EXCLUDES, not by what it includes.** An include list is
 * itself an unchecked claim about which files matter, and it is wrong in the
 * direction nobody notices. `guide/federation.md` is tracked, user-facing, and
 * linked from two shipped documents; it described a system federation v5
 * deleted, and sat green through a whole plan of doc-consistency work because
 * it was not on anyone's list. The list was green because it was not looking.
 *
 * So a new documentation tree is covered by default, and dropping one out is a
 * deliberate act with a reason attached that a test then checks still applies.
 *
 * **Sweeping nothing and sweeping everything are indistinguishable from a green
 * run.** Every caller owes a coverage assertion — that the sweep reached the
 * documents it should, and that it extracted something from them — because a
 * suite green because it looked and found nothing reads exactly like a suite
 * green because it never looked. That is the failure the include list was.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

export const ROOT = join(import.meta.dirname, '..', '..');

/** Paths the sweeps do not reach, and why each one is out. */
export const EXCLUDED = [
  // Third-party source: not ours to edit, and nobody reads it as guidance.
  { path: 'plugin/vendor/', why: 'vendored third-party' },
  { path: 'plugin/scripts/lib/vendor/', why: 'vendored third-party' },
  // A guard has to be able to name what it forbids. The dead-flow test lists
  // every dead needle; the command sweep uses `--peer-id` as a negative
  // control. Tests are also nobody's instructions, and a fixture vault is
  // arbitrary content by design — its notes exist to be indexed, not believed.
  { path: 'tests/', why: 'a guard must be able to name what it forbids' },
  // Records of the past, which MUST name the thing they record: the changelog
  // entry announcing that `peer_id` is gone has to be able to write `peer_id`.
  { path: 'CHANGELOG.md', why: 'a historical record names what it removed' },
  { path: 'REMEDIATION-PLAN.md', why: 'a historical record of a past remediation' },
  { path: 'INTEGRITY-AUDIT-REPORT.md', why: 'a historical audit record' },
  { path: 'SPIKE-injection-framing.md', why: 'a historical spike write-up' },
];

/** The exclusion covering `rel`, or undefined. */
export function excludedBy(rel) {
  return EXCLUDED.find((e) => rel === e.path || rel.startsWith(e.path.replaceAll('/', sep)));
}

/**
 * Every tracked file matching `globs`, minus [`EXCLUDED`], repo-relative.
 *
 * `git ls-files` rather than a directory walk, deliberately. It is the honest
 * definition of "what this repository publishes": gitignored trees (`docs/`,
 * `node_modules/`) and a developer's untracked scratch file drop out by
 * construction rather than by another list to maintain — and an untracked
 * draft cannot fail somebody else's build.
 */
export function publishedFiles(...globs) {
  const out = execFileSync('git', ['ls-files', '-z', ...globs], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return out
    .split('\0')
    .filter(Boolean)
    .filter((rel) => !excludedBy(rel));
}

/** Exclusions naming a path that no longer exists — coverage that reads as real and is not. */
export function rottedExclusions() {
  return EXCLUDED.filter(({ path }) => {
    try {
      const abs = join(ROOT, path);
      return path.endsWith('/') ? readdirSync(abs).length === 0 : !statSync(abs).isFile();
    } catch {
      return true;
    }
  }).map(({ path }) => path);
}
