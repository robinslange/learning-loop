#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  runHook,
  resolvePluginData,
  resolveVaultPath,
  findBinary as findBinaryShared,
  isVaultNote,
} from './lib/common.mjs';
import { loadVaultSnapshot } from './lib/snapshot.mjs';
import { parseFrontmatter, parseTags, extractWikilinks } from '../scripts/lib/markdown-parse.mjs';
import { HookConfig } from '../scripts/lib/hook-config.mjs';
import { spawnEnv } from '../scripts/lib/env.mjs';
import { logError } from '../scripts/lib/log.mjs';
import { emitJson } from './lib/io.mjs';

function findDuplicateTags(tags) {
  const seen = new Set();
  const dupes = new Set();
  for (const t of tags) {
    if (seen.has(t)) dupes.add(t);
    seen.add(t);
  }
  return [...dupes];
}

function buildNoteIndex(vaultRoot) {
  const snap = loadVaultSnapshot(vaultRoot);
  return new Set((snap?.notes ?? []).map((n) => `${n.basename}.md`));
}

function noteExistsInIndex(name, noteIndex) {
  return noteIndex.has(`${name}.md`);
}

function checkBodySourceLeak(fm, body) {
  if (!fm.source) return null;
  const match = body.match(/^Sources?:/im);
  if (!match) return null;
  return `Body has \`${match[0]}\` line while frontmatter already declares \`source:\`. Capture-rules: sources go in frontmatter, not body. Remove the body line, or remove the frontmatter \`source:\` if the body citation is the authoritative one.`;
}

function checkDuplicateNote(filePath, title, vaultRoot) {
  try {
    const binary = findBinaryShared();
    if (!binary) return null;
    const dbPath = join(vaultRoot, '.vault-search', 'vault-index.db');
    if (!existsSync(dbPath)) return null;

    const out = execFileSync(
      binary.bin,
      ['reflect-scan', dbPath, title, '--top', '1', '--candidates', '5'],
      {
        encoding: 'utf-8',
        timeout: HookConfig.QUERY_TIMEOUT_MS,
        env: spawnEnv({ ORT_DYLIB_PATH: binary.binDir, ORT_LIB_LOCATION: binary.binDir }),
      },
    );
    const result = JSON.parse(out);
    const q = result.queries && result.queries[0];
    if (!q || !q.top_match_similarity || q.top_match_similarity < HookConfig.SIMILARITY_THRESHOLD)
      return null;
    const topResult = q.results && q.results[0];
    if (!topResult) return null;

    const topAbsolute = resolve(join(vaultRoot, topResult.path));
    if (topAbsolute === resolve(filePath)) return null;

    const pct = Math.round(q.top_match_similarity * 100);
    return `Potential duplicate: "${topResult.title || topResult.path}" at ${topResult.path} (${pct}% similar).`;
  } catch (err) {
    logError('pre-write-check.checkDuplicateNote', err);
    return null;
  }
}

function deny(reason) {
  emitJson({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}

function warn(context) {
  emitJson({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: context,
    },
  });
}

runHook(({ tool, input }) => {
  if (tool !== 'Write') return;

  const filePath = input.file_path;
  const content = input.content || '';
  if (!filePath) return;

  const vaultRoot = resolveVaultPath();
  if (!isVaultNote(filePath, vaultRoot)) return;

  const { fm, body: fmBody } = parseFrontmatter(content);
  if (Object.keys(fm).length > 0) {
    const tags = parseTags(fm);
    const dupes = findDuplicateTags(tags);
    if (dupes.length > 0) {
      deny(`Duplicate tags found: [${dupes.join(', ')}]. Remove duplicates before writing.`);
      return;
    }
  }

  const warnings = [];

  const bodySourceWarning = checkBodySourceLeak(fm, fmBody);
  if (bodySourceWarning) warnings.push(bodySourceWarning);

  const links = extractWikilinks(fmBody);
  const noteIndex = buildNoteIndex(vaultRoot);
  const broken = links.filter((l) => {
    const target = l.split('#')[0].trim();
    return target && !noteExistsInIndex(target, noteIndex);
  });
  if (broken.length > 0) {
    warnings.push(
      `Broken wikilinks: ${broken.map((l) => '[[' + l + ']]').join(', ')} not found in vault.`,
    );
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
