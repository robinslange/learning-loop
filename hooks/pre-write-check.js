#!/usr/bin/env node
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runHook, resolvePluginData, resolveVaultPath, findBinary as findBinaryShared, isVaultNote } from './lib/common.mjs';

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
const TITLE_INDEX_EXTRA_DIRS = ['Excalidraw'];

function buildNoteIndex(vaultRoot) {
  const index = new Set();
  for (const dir of [...VAULT_DIRS, ...TITLE_INDEX_EXTRA_DIRS]) {
    try {
      const files = readdirSync(join(vaultRoot, dir), { recursive: true });
      for (const f of files) {
        const name = basename(f);
        if (name.endsWith('.md')) index.add(name);
      }
    } catch {}
  }
  return index;
}

function noteExistsInIndex(name, noteIndex) {
  return noteIndex.has(`${name}.md`);
}

function checkDuplicateNote(filePath, title, vaultRoot) {
  try {
    const binary = findBinaryShared();
    if (!binary) return null;
    const dbPath = join(vaultRoot, '.vault-search', 'vault-index.db');
    if (!existsSync(dbPath)) return null;

    const out = execFileSync(binary.bin, ['reflect-scan', dbPath, title, '--top', '1', '--candidates', '5'], {
      encoding: 'utf-8',
      timeout: 3000,
      env: { ...process.env, ORT_DYLIB_PATH: binary.binDir, ORT_LIB_LOCATION: binary.binDir },
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

runHook(({ tool, input }) => {
  if (tool !== 'Write') return;

  const filePath = input.file_path;
  const content = input.content || '';
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
  const noteIndex = buildNoteIndex(vaultRoot);
  const broken = links.filter(l => !noteExistsInIndex(l, noteIndex));
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
});
