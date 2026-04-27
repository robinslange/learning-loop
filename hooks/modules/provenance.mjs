// hooks/modules/provenance.mjs: provenance event emission.
// Extracted from hooks/post-tool-provenance.js. Calls emitProvenance inline
// (no subprocess) to keep the post-tool hot path under 60ms. Vault-less:
// runs without ctx.vaultRoot for Agent/Skill events.

import { emitProvenance, vaultRelPath, classifyVaultPath } from '../lib/common.mjs';

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
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (fmMatch) {
        const tagMatch = fmMatch[1].match(/tags:\s*\[([^\]]*)\]/);
        if (tagMatch) {
          event.tags = tagMatch[1].split(',').map((t) => t.trim().replace(/['"]/g, ''));
        }
      }
      emitProvenance(event);
      return;
    }

    if (tool === 'Agent') {
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
  } catch {}
}
