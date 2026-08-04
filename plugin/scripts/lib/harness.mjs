// scripts/lib/harness.mjs : which coding agent is running the plugin.
//
// Two harnesses load this plugin from the same tree. Claude Code reads
// .claude-plugin/plugin.json; Codex reads .codex-plugin/plugin.json and the
// same hooks/hooks.json. Almost nothing needs to branch on the answer — the
// hook I/O contract, the skill format, and CLAUDE_PLUGIN_ROOT are identical on
// both. Branch only where a capability genuinely differs, and say why at the
// call site.

import { env } from './env.mjs';

export const CLAUDE_CODE = 'claude-code';
export const CODEX = 'codex';

/**
 * Resolves the active harness.
 *
 * LL_HARNESS wins when set: it is an explicit statement, written by install.sh
 * into the Codex shell environment policy. Otherwise PLUGIN_ROOT decides —
 * Codex sets it for plugin-bundled hooks alongside the CLAUDE_-prefixed
 * compatibility pair, and Claude Code never sets it. Anything else is Claude
 * Code, which is the safe default: it is the harness with the larger tool
 * surface, so assuming it never disables a capability that exists.
 *
 * @returns {'claude-code' | 'codex'}
 */
export function harness() {
  if (env.LL_HARNESS === CODEX || env.LL_HARNESS === CLAUDE_CODE) return env.LL_HARNESS;
  return env.PLUGIN_ROOT ? CODEX : CLAUDE_CODE;
}

/** @returns {boolean} */
export function isCodex() {
  return harness() === CODEX;
}
