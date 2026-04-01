#!/usr/bin/env node
// post-tool-provenance.js — Automatic provenance capture from PostToolUse hook
// Logs vault writes, agent spawns, skill invocations, and vault searches.
// Receives hook JSON on stdin, emits provenance event, exits.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const PROVENANCE_DIR = join(
  process.env.CLAUDE_PLUGIN_DATA || join(homedir(), '.claude', 'plugins', 'data', 'learning-loop'),
  'provenance'
);
function home() { return process.env.HOME || process.env.USERPROFILE || homedir(); }

function resolveVaultPath() {
  if (process.env.VAULT_PATH) return resolve(process.env.VAULT_PATH);
  try {
    const pluginData = process.env.CLAUDE_PLUGIN_DATA || join(home(), '.claude', 'plugins', 'data', 'learning-loop');
    const cfg = JSON.parse(readFileSync(join(pluginData, 'config.json'), 'utf-8'));
    return resolve((cfg.vault_path || '~/brain/brain').replace(/^~/, home()));
  } catch {}
  try {
    const cfg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'config.json'), 'utf-8'));
    return resolve((cfg.vault_path || '~/brain/brain').replace(/^~/, home()));
  } catch {}
  return resolve(join(home(), 'brain', 'brain'));
}

const vaultPath = resolveVaultPath();
const VAULT_PREFIX = vaultPath + sep;

function getSessionId() {
  try {
    return readFileSync(join(tmpdir(), 'learning-loop-session-id'), 'utf8').trim();
  } catch {
    return 'unknown';
  }
}

function emit(event) {
  mkdirSync(PROVENANCE_DIR, { recursive: true });
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const record = {
    ts: now.toISOString(),
    session_id: getSessionId(),
    source: 'hook',
    ...event,
  };
  appendFileSync(join(PROVENANCE_DIR, `events-${month}.jsonl`), JSON.stringify(record) + '\n');
}

function vaultRelPath(filePath) {
  if (filePath && filePath.startsWith(VAULT_PREFIX)) {
    return filePath.slice(VAULT_PREFIX.length);
  }
  return null;
}

function classifyVaultPath(relPath) {
  const p = relPath.replace(/\\/g, '/');
  if (p.startsWith('0-inbox/')) return 'inbox';
  if (p.startsWith('1-fleeting/')) return 'fleeting';
  if (p.startsWith('2-literature/')) return 'literature';
  if (p.startsWith('3-permanent/')) return 'permanent';
  if (p.startsWith('4-projects/')) return 'project';
  if (p.startsWith('5-maps/')) return 'map';
  if (p.startsWith('_system/')) return 'system';
  return 'other';
}

// Read stdin
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const tool = data.tool_name;
    const toolInput = data.tool_input || {};

    // Vault writes
    if (tool === 'Write' || tool === 'Edit') {
      const rel = vaultRelPath(toolInput.file_path);
      if (rel) {
        const event = {
          action: tool === 'Write' ? 'vault-write' : 'vault-edit',
          target: rel,
          folder: classifyVaultPath(rel),
        };
        const content = toolInput.content || toolInput.new_string || '';
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (fmMatch) {
          const tagMatch = fmMatch[1].match(/tags:\s*\[([^\]]*)\]/);
          if (tagMatch) {
            event.tags = tagMatch[1].split(',').map(t => t.trim().replace(/['"]/g, ''));
          }
        }
        emit(event);
        return;
      }
    }

    // Agent spawns
    if (tool === 'Agent') {
      const agentType = toolInput.subagent_type || 'general-purpose';
      emit({
        action: 'agent-spawn',
        agent: agentType,
        description: toolInput.description || '',
        background: !!toolInput.run_in_background,
      });
      return;
    }

    // Skill invocations
    if (tool === 'Skill') {
      emit({
        action: 'skill-invoke',
        skill: toolInput.skill || '',
        args: toolInput.args || '',
      });
      return;
    }

    // Bash commands that touch provenance-emit (skill-initiated provenance)
    if (tool === 'Bash' && toolInput.command && toolInput.command.includes('provenance-emit')) {
      // Already captured by the emit itself, skip to avoid doubles
      return;
    }

  } catch {
    // Silent failure - don't block Claude
  }
});
