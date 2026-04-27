// hooks/modules/autolink.mjs : backlink loop + similarity-based auto-links.
// Extracted from hooks/post-write-autolink.js. The synchronous indexer-fallback
// that the old file ran when the watch daemon was absent is intentionally
// dropped here; under the new architecture the daemon owns all writes to
// vault-index.db.

import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { findBinary, isVaultNote } from '../lib/common.mjs';
import { buildNoteMapFromSnapshot, maybeSplice, removeFromSnapshot } from '../lib/snapshot.mjs';

const SIMILARITY_THRESHOLD = 0.65;
const MAX_AUTO_LINKS = 3;

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

export async function runAutolink(ctx) {
  const { tool, input, response, vaultRoot, snapshot } = ctx;
  if (tool !== 'Write' && tool !== 'Edit') return;
  if (!response || (typeof response === 'object' && response.success === false)) return;
  if (!vaultRoot) return;

  const filePath = input.file_path;
  if (!filePath) return;
  if (!isVaultNote(filePath, vaultRoot)) return;
  if (!snapshot) return;

  const sourceName = basename(filePath, '.md');
  const relativePath = filePath.slice(vaultRoot.length + 1);
  const dbPath = join(vaultRoot, '.vault-search', 'vault-index.db');

  let content;
  if (tool === 'Write') {
    content = input.content || '';
  } else {
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      return;
    }
  }

  const folder = relativePath.split('/')[0];
  maybeSplice(snapshot, {
    folder,
    basename: sourceName,
    rel_path: relativePath.split('\\').join('/'),
  });

  const existingLinks = extractWikilinks(content);
  const binary = findBinary();
  const noteMap = buildNoteMapFromSnapshot(snapshot, vaultRoot);

  for (const linkName of existingLinks) {
    if (linkName === sourceName) continue;
    const targetPath = noteMap.get(`${linkName}.md`);
    if (!targetPath) continue;
    let targetContent;
    try {
      targetContent = readFileSync(targetPath, 'utf-8');
    } catch (e) {
      if (e.code === 'ENOENT') {
        const targetRel = targetPath
          .slice(vaultRoot.length + 1)
          .split('\\')
          .join('/');
        removeFromSnapshot(snapshot, targetRel);
      }
      continue;
    }
    if (targetContent.includes(`[[${sourceName}]]`)) continue;
    const needsNewline = targetContent.length > 0 && !targetContent.endsWith('\n');
    appendFileSync(targetPath, (needsNewline ? '\n' : '') + `[[${sourceName}]]\n`);
  }

  if (tool !== 'Write') return;
  if (!binary || !existsSync(dbPath)) return;

  let similar;
  try {
    const out = execFileSync(binary.bin, ['similar', dbPath, relativePath, '--top', '5'], {
      encoding: 'utf-8',
      timeout: 1000,
      env: { ...process.env, ORT_DYLIB_PATH: binary.binDir, ORT_LIB_LOCATION: binary.binDir },
    });
    similar = JSON.parse(out);
  } catch {
    return;
  }

  const currentContent = readFileSync(filePath, 'utf-8');
  const diskLinks = extractWikilinks(currentContent);
  const candidates = similar
    .filter((r) => r.score >= SIMILARITY_THRESHOLD)
    .filter((r) => {
      const name = basename(r.path, '.md');
      return name !== sourceName && !diskLinks.has(name);
    })
    .slice(0, MAX_AUTO_LINKS);

  if (candidates.length === 0) return;

  const autoLinks = candidates.map((r) => `[[${basename(r.path, '.md')}]]`).join('\n');
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
}
