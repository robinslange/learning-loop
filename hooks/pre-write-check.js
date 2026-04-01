#!/usr/bin/env node
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, sep, basename } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

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

function parseFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  return m[1];
}

function parseTags(fm) {
  const inlineMatch = fm.match(/^tags:\s*\[([^\]]*)\]/m);
  if (inlineMatch) {
    return inlineMatch[1].split(',').map(t => t.trim().replace(/['"]/g, '')).filter(Boolean);
  }
  const blockMatch = fm.match(/^tags:\s*\n((?:\s+-\s+.*\n?)*)/m);
  if (blockMatch) {
    return blockMatch[1].split('\n')
      .map(l => l.replace(/^\s*-\s*/, '').trim().replace(/['"]/g, ''))
      .filter(Boolean);
  }
  return [];
}

function findDuplicateTags(tags) {
  const seen = new Set();
  const dupes = new Set();
  for (const t of tags) {
    if (seen.has(t)) dupes.add(t);
    seen.add(t);
  }
  return [...dupes];
}

function extractWikilinks(body) {
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

function noteExistsInVault(name, vaultRoot) {
  const target = `${name}.md`;
  for (const dir of VAULT_DIRS) {
    const dirPath = join(vaultRoot, dir);
    try {
      const files = readdirSync(dirPath, { recursive: true });
      if (files.some(f => basename(f) === target)) return true;
    } catch {}
  }
  return false;
}

function checkDuplicateNote(filePath, title, vaultRoot) {
  try {
    const pluginData = process.env.CLAUDE_PLUGIN_DATA || join(home(), '.claude', 'plugins', 'data', 'learning-loop');
    const binPath = join(pluginData, 'bin', 'll-search');
    if (!existsSync(binPath)) return null;
    const dbPath = join(vaultRoot, '.vault-search', 'vault-index.db');
    if (!existsSync(dbPath)) return null;

    const out = execFileSync(binPath, ['reflect-scan', dbPath, title, '--top', '1', '--candidates', '5'], {
      encoding: 'utf-8',
      timeout: 3000,
    });
    const result = JSON.parse(out);
    const q = result.queries && result.queries[0];
    if (!q || !q.top_match_similarity || q.top_match_similarity < 0.85) return null;
    const topResult = q.results && q.results[0];
    if (!topResult) return null;

    const topAbsolute = resolve(join(vaultRoot, topResult.path));
    if (topAbsolute === resolve(filePath)) return null;

    const pct = Math.round(q.top_match_similarity * 100);
    return `Potential duplicate: "${topResult.title || topResult.path}" at ${topResult.path} (${pct}% similar).`;
  } catch {
    return null;
  }
}

function deny(reason) {
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
  process.stdout.write(JSON.stringify(out));
}

function warn(context) {
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: context,
    },
  };
  process.stdout.write(JSON.stringify(out));
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    if (data.tool_name !== 'Write') return;

    const filePath = data.tool_input?.file_path;
    const content = data.tool_input?.content || '';
    if (!filePath) return;

    const vaultRoot = resolveVaultPath();
    if (!isVaultNote(filePath, vaultRoot)) return;

    const fm = parseFrontmatter(content);
    if (fm) {
      const tags = parseTags(fm);
      const dupes = findDuplicateTags(tags);
      if (dupes.length > 0) {
        deny(`Duplicate tags found: [${dupes.join(', ')}]. Remove duplicates before writing.`);
        return;
      }
    }

    const warnings = [];

    const fmEnd = content.match(/^---\n[\s\S]*?\n---\n?/);
    const body = fmEnd ? content.slice(fmEnd[0].length) : content;
    const links = extractWikilinks(body);
    const broken = links.filter(l => !noteExistsInVault(l, vaultRoot));
    if (broken.length > 0) {
      warnings.push(`Broken wikilinks: ${broken.map(l => '[[' + l + ']]').join(', ')} not found in vault.`);
    }

    const titleMatch = content.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : null;
    const dupeWarning = title ? checkDuplicateNote(filePath, title, vaultRoot) : null;
    if (dupeWarning) {
      warnings.push(dupeWarning);
    }

    if (warnings.length > 0) {
      warn(warnings.join('\n'));
    }
  } catch {
    // Silent failure
  }
});
