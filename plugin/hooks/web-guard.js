import { runHook } from './lib/common.mjs';
import { emitJson } from './lib/io.mjs';

const BLOCKED_TOOLS = new Set(['WebSearch', 'WebFetch']);

// Codex routes hosted WebSearch and WebFetch outside the local hook path, so on
// that harness the shell is the only web access a hook can still see. Only the
// Codex-only hooks file wires Bash to this guard; Claude Code pays nothing.
const FETCHER = /(?:^|[\s;&|(`$])(?:curl|wget|xh|aria2c|httpie)(?=\s)/;
const URL_RE = /https?:\/\/[^\s'"`<>]+/gi;
const LOCAL = /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?:[:/]|$)/i;

const GATEWAY =
  'Route web access through the source gateway instead: node ' +
  '"${CLAUDE_PLUGIN_ROOT}/bin/source-gateway.mjs" search --q "<query>" --json ' +
  '(or fetch --url <url>, or research --q "<question>"). This keeps every source config-selected.';

/**
 * Names the ungoverned web access in a tool call, or null when there is none.
 * A shell fetcher aimed only at localhost is not web access: that is the local
 * model, and denying it would break an air-gapped install.
 */
function webTarget(tool, input) {
  if (BLOCKED_TOOLS.has(tool)) return tool;
  if (tool !== 'Bash') return null;
  const command = String(input?.command || '');
  if (!FETCHER.test(command)) return null;
  const remote = (command.match(URL_RE) || []).find((u) => !LOCAL.test(u));
  return remote ? `Fetching ${remote} from the shell` : null;
}

/**
 * Deny ungoverned web access; hooks.json wires this as an unconditional
 * PreToolUse matcher (main session included, since PreToolUse cannot scope to
 * subagents). Web access routes through the source gateway instead. Returns
 * the PreToolUse deny payload for a blocked call, else null (pass-through).
 * Pure, no stdin/process, so it is unit-testable.
 */
export function webGuardDecision(tool, input) {
  const target = webTarget(tool, input);
  if (!target) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `${target} is disabled for research in this plugin. ${GATEWAY}`,
    },
  };
}

runHook(async ({ tool, input }) => {
  const decision = webGuardDecision(tool, input);
  if (decision) emitJson(decision);
});
