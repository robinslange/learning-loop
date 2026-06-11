// scripts/librarian/daemon-helpers.mjs : pure helper functions for the daemon loop.
//
// Extracted from daemon.mjs to keep that module under the 250 LOC limit.
// Contains: note selection, staleness check, task classification, vocabulary, body reader.

import { statSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { VAULT_PATH, DB_PATH } from '../lib/constants.mjs';
import { appendItem, newItemId } from './queue.mjs';
import { logError } from '../lib/log.mjs';
import { stripFrontmatter } from '../lib/markdown-parse.mjs';

/**
 * Pick a random unvisited note from allPaths.
 * Returns null when all paths have been visited.
 */
export function pickNote(allPaths, visited) {
  const visitedSet = new Set(visited);
  const unvisited = allPaths.filter((p) => !visitedSet.has(p));
  if (!unvisited.length) return null;
  return unvisited[Math.floor(Math.random() * unvisited.length)];
}

/**
 * Append a staleness_suspect queue item if the note is old and has version signals.
 * @returns {boolean} true if a suspect was queued.
 */
export function checkStaleness(notePath) {
  const fullPath = join(VAULT_PATH, notePath);
  const mtime = statSync(fullPath).mtimeMs;
  const ageMs = Date.now() - mtime;
  if (ageMs < 60 * 24 * 60 * 60 * 1000) return false;

  const body = readFileSync(fullPath, 'utf-8');
  const versionPattern = /v\d+\.\d+|\b20\d{2}\b|deprecated/i;
  const specificityPattern = /\d+\.?\d*\s*(ms|s|MB|GB|%|fps|req\/s|items|notes|tokens)/i;

  if (versionPattern.test(body) && specificityPattern.test(body)) {
    const matched = [];
    const vm = body.match(versionPattern);
    if (vm) matched.push(vm[0]);
    const sm = body.match(specificityPattern);
    if (sm) matched.push(sm[0]);

    appendItem({
      id: newItemId(),
      task: 'staleness_suspect',
      target: notePath,
      reason:
        'Note is ' +
        Math.floor(ageMs / 86400000) +
        ' days old and contains version/specificity signals.',
      matched_patterns: matched,
      status: 'pending',
      created_at: new Date().toISOString(),
    });
    return true;
  }
  return false;
}

/**
 * Determine which investigation tasks are needed for a note.
 * @param {string} notePath
 * @param {object} db - vault SQLite DB (sql.js exec interface)
 * @returns {string[]}
 */
export async function noteNeedsInvestigation(notePath, db) {
  const s = notePath.split('/').pop().replace(/\.md$/, '');
  const inlinkRow = db.exec(
    "SELECT COUNT(*) FROM links WHERE target_path = ? AND target_path NOT LIKE '%[%'",
    [s],
  );
  const inlinks = inlinkRow.length ? inlinkRow[0].values[0][0] : 0;

  const tagRow = db.exec('SELECT tags FROM notes WHERE path = ?', [notePath]);
  const tagsStr = tagRow.length && tagRow[0].values.length ? tagRow[0].values[0][0] : '';
  const tagCount = (tagsStr || '').split(' ').filter(Boolean).length;

  const tasks = [];
  if (inlinks === 0) tasks.push('link_check');
  if (notePath.startsWith('0-inbox/') || notePath.startsWith('1-fleeting/'))
    tasks.push('voice_gate');
  if (tagCount <= 1) tasks.push('tag_suggest');
  tasks.push('duplicate_check');
  return tasks;
}

/**
 * Build tag vocabulary from the vault DB (top 60 tags, frequency >= 3).
 */
export async function getTagVocabulary(db, structuralTags) {
  const rows = db.exec("SELECT tags FROM notes WHERE tags != ''");
  const counts = {};
  if (rows.length) {
    for (const [tagStr] of rows[0].values) {
      for (const t of tagStr.split(' ').filter(Boolean)) {
        counts[t] = (counts[t] || 0) + 1;
      }
    }
  }
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return ranked
    .filter(([t, n]) => n >= 3 && !structuralTags.has(t) && !t.startsWith('project/'))
    .slice(0, 60)
    .map(([t]) => t);
}

/**
 * Read note body, stripping frontmatter and capping at maxChars.
 */
export function readNoteBody(notePath, maxChars = 500) {
  const fullPath = join(VAULT_PATH, notePath);
  if (!existsSync(fullPath)) return null;
  const content = stripFrontmatter(readFileSync(fullPath, 'utf-8'));
  return content.trim().slice(0, maxChars);
}

/**
 * Get all note paths from the vault DB.
 */
export async function getAllNotePaths(db) {
  const result = db.exec('SELECT path FROM notes');
  if (!result.length) return [];
  return result[0].values.map((r) => r[0]);
}
