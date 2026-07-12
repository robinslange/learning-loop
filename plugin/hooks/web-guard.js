import { runHook } from './lib/common.mjs';
import { emitJson } from './lib/io.mjs';

const BLOCKED = new Set(['WebSearch', 'WebFetch']);

/**
 * Deny raw web tools globally; hooks.json wires this as an unconditional
 * PreToolUse matcher (main session included, since PreToolUse cannot scope to
 * subagents). Web access routes through the source gateway instead. Returns
 * the PreToolUse deny payload for a blocked tool, else null (pass-through).
 * Pure, no stdin/process, so it is unit-testable.
 */
export function webGuardDecision(tool) {
  if (!BLOCKED.has(tool)) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        tool +
        ' is disabled for research in this plugin. Route web access through the source ' +
        'gateway instead: node "${CLAUDE_PLUGIN_ROOT}/bin/source-gateway.mjs" search --q "<query>" --json ' +
        '(or fetch --url <url>, or research --q "<question>"). This keeps every source config-selected.',
    },
  };
}

runHook(async ({ tool }) => {
  const decision = webGuardDecision(tool);
  if (decision) emitJson(decision);
});
