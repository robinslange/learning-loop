// hooks/modules/provenance.mjs — provenance event emission.
// Extracted from hooks/post-tool-provenance.js. Spawns scripts/provenance.mjs
// once per qualifying event with the same JSON payload shape the old hook
// produced. Vault-less: runs without ctx.vaultRoot for Agent/Skill events.

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { vaultRelPath, classifyVaultPath } from '../lib/common.mjs';

const PROVENANCE_SCRIPT = resolve(import.meta.dirname, '..', '..', 'scripts', 'provenance.mjs');

function emit(event) {
  try {
    execFileSync('node', [PROVENANCE_SCRIPT, JSON.stringify({ source: 'hook', ...event })], {
      timeout: 3000,
      stdio: 'ignore',
    });
  } catch {}
}

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
      emit(event);
      return;
    }

    if (tool === 'Agent') {
      emit({
        action: 'agent-spawn',
        agent: input.subagent_type || 'general-purpose',
        description: input.description || '',
        background: !!input.run_in_background,
      });
      return;
    }

    if (tool === 'Skill') {
      emit({
        action: 'skill-invoke',
        skill: input.skill || '',
        args: input.args || '',
      });
    }
  } catch {}
}
