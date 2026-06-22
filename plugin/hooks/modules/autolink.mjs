// hooks/modules/autolink.mjs : backlink loop + similarity-based auto-links.
// Extracted from the pre-coalescing standalone autolink hook. The synchronous
// indexer-fallback that the old file ran when the watch daemon was absent is
// intentionally dropped here; under the new architecture the daemon owns all
// writes to vault-index.db.

import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { findBinary, isVaultNote } from '../lib/common.mjs';
import { buildNoteMapFromSnapshot, maybeSplice, removeFromSnapshot } from '../lib/snapshot.mjs';
import { extractWikilinks, stripFrontmatter } from '../../scripts/lib/markdown-parse.mjs';
import { HookConfig } from '../../scripts/lib/hook-config.mjs';
import { spawnEnv, env, coerceNumber } from '../../scripts/lib/env.mjs';
import { logError } from '../../scripts/lib/log.mjs';

const SIMILARITY_THRESHOLD = 0.65;
const MAX_AUTO_LINKS = 3;

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
    } catch (err) {
      logError('autolink.readFile', err);
      return;
    }
  }

  const folder = relativePath.split('/')[0];
  maybeSplice(snapshot, {
    folder,
    basename: sourceName,
    rel_path: relativePath.split('\\').join('/'),
  });

  const body = stripFrontmatter(content);
  const existingLinks = new Set(
    extractWikilinks(body)
      .map((l) => l.split('#')[0].trim())
      .filter(Boolean),
  );
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
      timeout: coerceNumber(env.LL_AUTOLINK_ML_TIMEOUT_MS, HookConfig.AUTOLINK_ML_TIMEOUT_MS),
      env: spawnEnv({ ORT_DYLIB_PATH: binary.binDir, ORT_LIB_LOCATION: binary.binDir }),
    });
    similar = JSON.parse(out);
  } catch (err) {
    logError('autolink.execFileSync', err);
    return;
  }

  const currentContent = readFileSync(filePath, 'utf-8');
  const currentBody = stripFrontmatter(currentContent);
  const diskLinks = new Set(
    extractWikilinks(currentBody)
      .map((l) => l.split('#')[0].trim())
      .filter(Boolean),
  );
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
    } catch (err) {
      logError('autolink.readTargetContent', err);
    }
  }
}
