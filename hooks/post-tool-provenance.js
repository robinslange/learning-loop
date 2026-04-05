#!/usr/bin/env node
// post-tool-provenance.js — Automatic provenance capture from PostToolUse hook
// Logs vault writes, agent spawns, and skill invocations.

import { runHook, resolveVaultPath, vaultRelPath, classifyVaultPath, emitProvenance } from './lib/common.mjs';

const vaultPath = resolveVaultPath();

runHook(({ tool, input }) => {
  // Vault writes
  if (tool === 'Write' || tool === 'Edit') {
    const rel = vaultRelPath(input.file_path, vaultPath);
    if (rel) {
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
          event.tags = tagMatch[1].split(',').map(t => t.trim().replace(/['"]/g, ''));
        }
      }
      emitProvenance(event);
    }
    return;
  }

  // Agent spawns
  if (tool === 'Agent') {
    emitProvenance({
      action: 'agent-spawn',
      agent: input.subagent_type || 'general-purpose',
      description: input.description || '',
      background: !!input.run_in_background,
    });
    return;
  }

  // Skill invocations
  if (tool === 'Skill') {
    emitProvenance({
      action: 'skill-invoke',
      skill: input.skill || '',
      args: input.args || '',
    });
  }
});
