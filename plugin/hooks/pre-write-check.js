#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
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

const DASH_RE = /[—–]/;

// Em/en-dashes are a voice violation in body prose (persona.md: "No em dashes,
// no en dashes."). They are legitimate structural annotation on Source:/Related:
// lines, which separate a reference from its gloss, so those lines are exempt.
function findEmDashLines(body) {
  const offending = [];
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^(Sources?:|Related:)/.test(line.trimStart())) continue;
    if (DASH_RE.test(line)) {
      offending.push({ line: i + 1, text: line.trim() });
    }
  }
  return offending;
}

// Count em/en-dashes on non-exempt lines (same Source:/Related: exemption as
// findEmDashLines). Used to detect dashes ADDED by an Edit: a dash that exists
// in both old_string and new_string is pre-existing and must not deny.
function countExposedDashes(text) {
  let count = 0;
  for (const line of text.split('\n')) {
    if (/^(Sources?:|Related:)/.test(line.trimStart())) continue;
    const matches = line.match(/[—–]/g);
    if (matches) count += matches.length;
  }
  return count;
}

function buildNoteIndex(vaultRoot) {
  const snap = loadVaultSnapshot(vaultRoot);
  const notes = snap?.notes ?? [];
  const basenames = new Set();
  const relPaths = new Set();
  for (const n of notes) {
    basenames.add(`${n.basename}.md`);
    if (n.rel_path) {
      relPaths.add(n.rel_path);
      relPaths.add(n.rel_path.replace(/\.md$/, ''));
    }
  }
  return { basenames, relPaths };
}

function noteExistsInIndex(name, noteIndex) {
  if (noteIndex.basenames.has(`${name}.md`)) return true;
  if (noteIndex.relPaths.has(name)) return true;
  if (noteIndex.relPaths.has(`${name}.md`)) return true;
  return false;
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
  if (tool !== 'Write' && tool !== 'Edit') return;

  const filePath = input.file_path;
  if (!filePath) return;

  const vaultRoot = resolveVaultPath();
  if (!isVaultNote(filePath, vaultRoot)) return;

  // Edit payloads carry string fragments, not whole notes: deny only dashes
  // the edit ADDS, warn on broken wikilinks in the replacement text, and skip
  // the duplicate-tag/duplicate-note checks (a fragment has no reliable
  // frontmatter or title to judge).
  if (tool === 'Edit') {
    const oldString = input.old_string || '';
    const newString = input.new_string || '';

    if (countExposedDashes(newString) > countExposedDashes(oldString)) {
      const offending = findEmDashLines(newString);
      const list = offending.map((l) => `  ${l.text}`).join('\n');
      deny(
        `This edit adds em/en-dashes to body prose (persona voice rule "no em dashes, no en dashes"):\n${list}\n` +
          `Replace each with a comma, colon, or semicolon. If the dash is structural ` +
          `annotation (reference + gloss), move it to a Source: or Related: line, which are exempt.`,
      );
      return;
    }

    const noteIndex = buildNoteIndex(vaultRoot);
    const broken = extractWikilinks(newString).filter((l) => {
      const target = l.split('#')[0].trim();
      return target && !noteExistsInIndex(target, noteIndex);
    });
    if (broken.length > 0) {
      warn(`Broken wikilinks: ${broken.map((l) => '[[' + l + ']]').join(', ')} not found in vault.`);
    }
    return;
  }

  const content = input.content || '';
  const { fm, body: fmBody } = parseFrontmatter(content);
  if (Object.keys(fm).length > 0) {
    const tags = parseTags(fm);
    const dupes = findDuplicateTags(tags);
    if (dupes.length > 0) {
      deny(`Duplicate tags found: [${dupes.join(', ')}]. Remove duplicates before writing.`);
      return;
    }
  }

  // Same added-only delta rule as the Edit path: a Write that rewrites an
  // existing note (reflect refinement applies upstream edits via Write) must
  // not be denied for dashes the note already carries on disk. New files keep
  // the any-dash deny.
  const emDashLines = findEmDashLines(fmBody);
  if (emDashLines.length > 0) {
    let dashAdded = true;
    if (existsSync(filePath)) {
      const { body: onDiskBody } = parseFrontmatter(readFileSync(filePath, 'utf-8'));
      dashAdded = countExposedDashes(fmBody) > countExposedDashes(onDiskBody);
    }
    if (dashAdded) {
      const list = emDashLines.map((l) => `  line ${l.line}: ${l.text}`).join('\n');
      deny(
        `Em/en-dashes in body prose (persona voice rule "no em dashes, no en dashes"):\n${list}\n` +
          `Replace each with a comma, colon, or semicolon. If the dash is structural ` +
          `annotation (reference + gloss), move it to a Source: or Related: line, which are exempt.`,
      );
      return;
    }
  }

  const warnings = [];

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
