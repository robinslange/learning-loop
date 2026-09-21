// hooks/modules/provenance.mjs: provenance event emission.
// Extracted from hooks/post-tool-provenance.js. Calls emitProvenance inline
// (no subprocess) to keep the post-tool hot path under 60ms. Vault-less:
// runs without ctx.vaultRoot for Task/Skill events.

import {
  emitProvenance,
  vaultRelPath,
  classifyVaultPath,
  resolvePluginData,
  getSessionId,
} from '../lib/common.mjs';
import { parseFrontmatter, parseTags } from '../../scripts/lib/markdown-parse.mjs';
import { logError } from '../../scripts/lib/log.mjs';
import { writeMarker, MARKER_PATHS } from '../../scripts/lib/marker-cache.mjs';
import { normaliseSkill, normaliseAgent } from '../../scripts/lib/provenance-skill.mjs';
import { pluginRoot } from '../../scripts/lib/plugin-meta.mjs';

export async function runProvenance(ctx) {
  try {
    const { tool, input, vaultRoot } = ctx;

    if (tool === 'Write' || tool === 'Edit') {
      if (!vaultRoot) return;
      const rel = vaultRelPath(input.file_path, vaultRoot);
      if (!rel) return;
      const event = {
        action: tool === 'Write' ? 'vault-write' : 'vault-edit',
        target: rel,
        folder: classifyVaultPath(rel),
      };
      const content = input.content || input.new_string || '';
      const { fm } = parseFrontmatter(content);
      if (Object.keys(fm).length > 0) {
        const tags = parseTags(fm);
        if (tags.length > 0) event.tags = tags;
      }
      emitProvenance(event);
      return;
    }

    // Claude Code spawns via Task/Agent and names the agent in `subagent_type`.
    // Codex spawns via `spawn_agent`, which the hook layer surfaces as `Agent`;
    // its argument names are not documented, so read the plausible keys and fall
    // back rather than losing the event.
    if (tool === 'Task' || tool === 'Agent') {
      emitProvenance({
        action: 'agent-spawn',
        agent: normaliseAgent(input.subagent_type || input.agent_type || input.agent),
        // Never fall back to the prompt: it is unbounded user text, and the
        // provenance log is not where it belongs.
        description: typeof input.description === 'string' ? input.description : '',
        background: !!input.run_in_background,
      });
      return;
    }

    if (tool === 'Skill') {
      emitProvenance({
        action: 'skill-invoke',
        skill: input.skill || '',
        args: input.args || '',
      });
      const pluginData = resolvePluginData();
      const sid = getSessionId();
      if (pluginData && sid && sid !== 'unknown') {
        const normalised = normaliseSkill(input.skill, pluginRoot());
        if (normalised) {
          writeMarker(MARKER_PATHS.currentSkill(pluginData, sid), {
            skill: normalised,
            ts: Date.now(),
          });
        } else {
          logError('provenance.unknownSkill', new Error('rejected skill value'), {
            length: String(input.skill || '').length,
          });
        }
      }
    }
  } catch (err) {
    logError('provenance', err);
  }
}
