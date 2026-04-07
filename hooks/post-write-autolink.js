#!/usr/bin/env node
import { readFileSync, appendFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, sep, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runHook, resolvePluginData, resolveVaultPath, findBinary } from './lib/common.mjs';

const SIMILARITY_THRESHOLD = 0.65;
const MAX_AUTO_LINKS = 3;
const VAULT_DIRS = ['0-inbox', '1-fleeting', '2-literature', '3-permanent', '4-projects', '5-maps'];
const TITLE_INDEX_EXTRA_DIRS = ['Excalidraw'];

function isWatchRunning() {
  try {
    const pid = parseInt(readFileSync(join(resolvePluginData(), 'watch.pid'), 'utf8').trim(), 10);
    process.kill(pid, 0);
    return true;
  } catch { return false; }
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
  return links;
}

function buildNoteMap(vaultRoot) {
  const map = new Map();
  for (const dir of [...VAULT_DIRS, ...TITLE_INDEX_EXTRA_DIRS]) {
    const dirPath = join(vaultRoot, dir);
    try {
      const files = readdirSync(dirPath, { recursive: true });
      for (const f of files) {
        const name = basename(String(f));
        if (name.endsWith('.md') && !map.has(name)) {
          map.set(name, join(dirPath, String(f)));
        }
      }
    } catch {}
  }
  return map;
}

runHook(({ tool, input, response }) => {
  if (tool !== 'Write' && tool !== 'Edit') return;
  if (!response || (typeof response === 'object' && response.success === false)) return;

  const filePath = input.file_path;
  if (!filePath) return;

  const vaultRoot = resolveVaultPath();
  if (!isVaultNote(filePath, vaultRoot)) return;

  const sourceName = basename(filePath, '.md');
  const relativePath = filePath.slice(vaultRoot.length + 1);
  const dbPath = join(vaultRoot, '.vault-search', 'vault-index.db');

  let content;
  if (tool === 'Write') {
    content = input.content || '';
  } else {
    try { content = readFileSync(filePath, 'utf-8'); } catch { return; }
  }

  const existingLinks = extractWikilinks(content);
  const binary = findBinary();
  const noteMap = buildNoteMap(vaultRoot);

  // --- Backlink logic (runs for both Write and Edit) ---
  for (const linkName of existingLinks) {
    if (linkName === sourceName) continue;
    const targetPath = noteMap.get(`${linkName}.md`);
    if (!targetPath) continue;
    const targetContent = readFileSync(targetPath, 'utf-8');
    if (targetContent.includes(`[[${sourceName}]]`)) continue;
    const needsNewline = targetContent.length > 0 && !targetContent.endsWith('\n');
    appendFileSync(targetPath, (needsNewline ? '\n' : '') + `[[${sourceName}]]\n`);
  }

  // --- Auto-link logic (Write only) ---
  if (tool !== 'Write') return;
  if (!binary || !existsSync(dbPath)) return;

  if (!isWatchRunning()) {
    try {
      execFileSync(binary.bin, ['index', vaultRoot, dbPath], {
        timeout: 5000, stdio: 'ignore',
        env: { ...process.env, ORT_DYLIB_PATH: binary.binDir, ORT_LIB_LOCATION: binary.binDir },
      });
    } catch {}
  }

  let similar;
  try {
    const out = execFileSync(binary.bin, ['similar', dbPath, relativePath, '--top', '5'], {
      encoding: 'utf-8', timeout: 1000,
      env: { ...process.env, ORT_DYLIB_PATH: binary.binDir, ORT_LIB_LOCATION: binary.binDir },
    });
    similar = JSON.parse(out);
  } catch { return; }

  const currentContent = readFileSync(filePath, 'utf-8');
  const diskLinks = extractWikilinks(currentContent);
  const candidates = similar
    .filter(r => r.score >= SIMILARITY_THRESHOLD)
    .filter(r => {
      const name = basename(r.path, '.md');
      return name !== sourceName && !diskLinks.has(name);
    })
    .slice(0, MAX_AUTO_LINKS);

  if (candidates.length === 0) return;

  const autoLinks = candidates.map(r => `[[${basename(r.path, '.md')}]]`).join('\n');
  const needsNewline = currentContent.length > 0 && !currentContent.endsWith('\n');
  appendFileSync(filePath, (needsNewline ? '\n' : '') + autoLinks + '\n');

  for (const r of candidates) {
    const targetPath = noteMap.get(basename(r.path));
    if (!targetPath) continue;
    try {
      const targetContent = readFileSync(targetPath, 'utf-8');
      if (targetContent.includes(`[[${sourceName}]]`)) continue;
      const needsNl = targetContent.length > 0 && !targetContent.endsWith('\n');
      appendFileSync(targetPath, (needsNl ? '\n' : '') + `[[${sourceName}]]\n`);
    } catch {}
  }
});
