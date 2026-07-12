// scripts/lib/cli-args.mjs : argv flag helpers shared by CLI scripts.
// Callers pass their own args array (usually process.argv.slice(2)).

export function hasFlag(args, flag) {
  return args.includes(flag);
}

/**
 * Value following `flag`, or `defaultVal` when the flag is absent or has no
 * (truthy) value after it.
 *
 * @param {string[]} args
 * @param {string} flag
 * @param {string | null} [defaultVal]
 * @returns {string | null}
 */
export function flagValue(args, flag, defaultVal = null) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : defaultVal;
}
