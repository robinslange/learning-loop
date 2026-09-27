// Stryker switches a mutant on through one environment variable. A child
// spawned with a minimal env drops it and runs the unmutated code, so every
// mutant only that child exercises survives. Spread this into any minimal env.
export function strykerEnv() {
  const active = process.env.__STRYKER_ACTIVE_MUTANT__;
  return active === undefined ? {} : { __STRYKER_ACTIVE_MUTANT__: active };
}
