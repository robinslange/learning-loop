// hooks/modules/provenance.mjs: provenance event emission.
// Extracted from hooks/post-tool-provenance.js. Calls emitProvenance inline
// (no subprocess) to keep the post-tool hot path under 60ms. Vault-less:
// runs without ctx.vaultRoot for Task/Skill events.

import { emitProvenance, vaultRelPath, classifyVaultPath } from '../lib/common.mjs';
import { parseFrontmatter, parseTags } from '../../scripts/lib/markdown-parse.mjs';
import { logError } from '../../scripts/lib/log.mjs';

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

    if (tool === 'Task') {
      emitProvenance({
        action: 'agent-spawn',
        agent: input.subagent_type || 'general-purpose',
        description: input.description || '',
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
    }
  } catch (err) {
    logError('provenance', err);
  }
}
