#!/usr/bin/env node
import { readFileSync, appendFileSync, readdirSync } from 'node:fs';
import { join, resolve, sep, basename } from 'node:path';
import { homedir } from 'node:os';

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

function isVaultNote(filePath, vaultRoot) {
  const prefix = vaultRoot + sep;
  if (!filePath.startsWith(prefix)) return false;
  if (!filePath.endsWith('.md')) return false;
  const rel = filePath.slice(prefix.length);
  const firstSegment = rel.split(sep)[0];
  if (firstSegment.startsWith('_') || firstSegment.startsWith('.')) return false;
  return true;
}

function extractWikilinks(content) {
  const fmEnd = content.match(/^---\n[\s\S]*?\n---\n?/);
  const body = fmEnd ? content.slice(fmEnd[0].length) : content;
  const links = new Set();
  const re = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const target = m[1].split('#')[0].trim();
    if (target) links.add(target);
  }
  return [...links];
}

const VAULT_DIRS = ['0-inbox', '1-fleeting', '2-literature', '3-permanent', '4-projects', '5-maps'];

function findNoteInVault(name, vaultRoot) {
  const target = `${name}.md`;
  for (const dir of VAULT_DIRS) {
    const dirPath = join(vaultRoot, dir);
    try {
      const files = readdirSync(dirPath, { recursive: true });
      for (const f of files) {
        if (basename(f) === target) return join(dirPath, f);
      }
    } catch {}
  }
  return null;
}

// appendFileSync is not atomic on Windows. The read-before-append dedup
// check is the primary guard against duplicate backlinks, not filesystem
// semantics.

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    if (data.tool_name !== 'Write') return;
    if (!data.tool_response?.success) return;

    const filePath = data.tool_input?.file_path;
    const content = data.tool_input?.content || '';
    if (!filePath) return;

    const vaultRoot = resolveVaultPath();
    if (!isVaultNote(filePath, vaultRoot)) return;

    const sourceName = basename(filePath, '.md');
    const links = extractWikilinks(content);

    for (const linkName of links) {
      if (linkName === sourceName) continue;

      const targetPath = findNoteInVault(linkName, vaultRoot);
      if (!targetPath) continue;

      const targetContent = readFileSync(targetPath, 'utf-8');
      if (targetContent.includes(`[[${sourceName}]]`)) continue;

      const needsNewline = targetContent.length > 0 && !targetContent.endsWith('\n');
      const backlink = (needsNewline ? '\n' : '') + `[[${sourceName}]]\n`;
      appendFileSync(targetPath, backlink);
    }
  } catch {
    // Silent failure: never break Claude's flow
  }
});
