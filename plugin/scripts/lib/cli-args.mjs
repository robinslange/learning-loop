// scripts/lib/cli-args.mjs : argv flag helpers shared by CLI scripts.
// Callers pass their own args array (usually process.argv.slice(2)).

export class UsageError extends Error {
  name = 'UsageError';
}

export function hasFlag(args, flag) {
  return args.includes(flag);
}

/**
 * Value following `flag`, or `defaultVal` when the flag is absent. A flag
 * that is present with nothing after it, or with another `--flag` after it,
 * throws UsageError rather than falling back: `--db --execute` must not run
 * against the default database, or against one named "--execute".
 *
 * @param {string[]} args
 * @param {string} flag
 * @param {string | null} [defaultVal]
 * @returns {string | null}
 */
export function flagValue(args, flag, defaultVal = null) {
  const i = args.indexOf(flag);
  if (i < 0) return defaultVal;
  const value = args[i + 1];
  if (!value || value.startsWith('--')) throw new UsageError(`${flag} needs a value`);
  return value;
}
