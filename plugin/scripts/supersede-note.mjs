#!/usr/bin/env node
// supersede-note.mjs : stamp invalidated:/superseded_by: on the note a
// supersession retires.
//
// The one mechanical writer for the frontmatter pair capture-rules.md
// defines and enrichVaultHits (hooks/lib/inject.mjs) honours. Both /rewrite's
// ARCHIVE step and /reflect refinement's supersede step call this instead of
// hand-editing frontmatter (refinement) or writing a plain-text stub
// retrieval cannot read (rewrite, before this change).
//
// Frontmatter is edited as raw lines, same approach as
// normalise-frontmatter.mjs: reserialising from the parsed map would rewrite
// quoting and key order the rest of the note never asked to change.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { relative } from 'node:path';
import { parseFrontmatter } from './lib/markdown-parse.mjs';
import { flagValue } from './lib/cli-args.mjs';
import { isMainModule } from './lib/is-main.mjs';
import { openEdgeDb, archiveOutgoingEdges, saveDb } from './lib/edges.mjs';
import { DATA_FILES } from './lib/paths.mjs';
import { logError } from './lib/log.mjs';
import { VAULT_PATH, PLUGIN_DATA } from './lib/constants.mjs';

const FM_SPLIT_RE = /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)/;

/**
 * Add `invalidated:` and, when a replacement exists, `superseded_by:` to a
 * note's frontmatter, in the exact form capture-rules.md defines. A stale
 * note retired by /verify with nothing superseding it gets `invalidated:`
 * alone. Never overwrites an existing `invalidated:` -- a note already
 * superseded stays as first recorded. An existing `superseded_by:` with no
 * paired `invalidated:` is dropped and replaced: the new supersession wins,
 * because the old pointer was never paired with an invalidation.
 *
 * `changed: false` carries a `reason` distinguishing why nothing was
 * written: `'no-frontmatter'` (the note has no `---` block at all, so the
 * caller cannot silently treat this as "already superseded") vs.
 * `'already-invalidated'` (the intended skip case).
 *
 * @param {string} raw the note's full text on disk
 * @param {{ date: string, replacementPath?: string }} opts
 * @returns {{ next: string, changed: boolean, reason?: string }}
 */
export function stampSupersession(raw, { date, replacementPath }) {
  const split = raw.match(FM_SPLIT_RE);
  if (!split) return { next: raw, changed: false, reason: 'no-frontmatter' };

  const { fm, body } = parseFrontmatter(raw);
  if (fm.invalidated) return { next: raw, changed: false, reason: 'already-invalidated' };

  // Detect the opening fence's line ending and join with it, so a CRLF note
  // doesn't come back with the fences on \r\n and the rebuilt interior on
  // bare \n.
  const eol = split[1].endsWith('\r\n') ? '\r\n' : '\n';

  const fmLines = split[2]
    .split(/\r?\n/)
    .filter((l) => l.length > 0 && !l.startsWith('superseded_by:'));
  fmLines.push(`invalidated: ${date}`);
  if (replacementPath) fmLines.push(`superseded_by: ${replacementPath}`);

  const next = split[1] + fmLines.join(eol) + split[3] + body;
  return { next, changed: true };
}

/**
 * Best-effort: archive the note's outgoing edges (source_graph='archived')
 * so a retired note stops counting as live justification in downstream
 * traversal. The note itself is not moved or overwritten by supersedeNoteFile,
 * so nothing else ever touches its edges. Failure here (no vault root known,
 * no edges db yet, a read/write error) must never fail the frontmatter stamp
 * that already succeeded -- it is logged and reported as 0.
 *
 * @param {string} filePath absolute path to the note being superseded
 * @param {string} vaultPath
 * @param {string} pluginData
 * @returns {Promise<number>} count of edges archived
 */
async function archiveNoteEdges(filePath, vaultPath, pluginData) {
  if (!vaultPath || !pluginData) return 0;
  const relPath = relative(vaultPath, filePath).split('\\').join('/');
  const dbPath = DATA_FILES.edgesDb(pluginData);
  if (!existsSync(dbPath)) return 0;
  try {
    const db = await openEdgeDb(dbPath);
    archiveOutgoingEdges(db, relPath);
    const archived = db.getRowsModified();
    saveDb(db, dbPath);
    db.close();
    return archived;
  } catch (err) {
    logError('supersede-note.archiveNoteEdges', err);
    return 0;
  }
}

/**
 * Stamp a note on disk. Returns the same shape as stampSupersession; writes
 * only when changed. On a successful stamp, also archives the note's
 * outgoing edges best-effort (see archiveNoteEdges) and reports the count as
 * `edgesArchived`.
 *
 * @param {string} filePath absolute path to the note being superseded
 * @param {{ date: string, replacementPath?: string, vaultPath?: string, pluginData?: string }} opts
 */
export async function supersedeNoteFile(
  filePath,
  { vaultPath = VAULT_PATH, pluginData = PLUGIN_DATA, ...opts } = {},
) {
  const raw = readFileSync(filePath, 'utf-8');
  const result = stampSupersession(raw, opts);
  if (result.changed) {
    writeFileSync(filePath, result.next);
    result.edgesArchived = await archiveNoteEdges(filePath, vaultPath, pluginData);
  }
  return result;
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const filePath = args[0];
  const replacementPath = flagValue(args, '--replacement', null);
  const date = flagValue(args, '--date', new Date().toISOString().slice(0, 10));
  if (!filePath) {
    console.error(
      'Usage: supersede-note.mjs <old-note-path> [--replacement <new-note-path>] [--date YYYY-MM-DD]',
    );
    process.exit(1);
  }
  const result = await supersedeNoteFile(filePath, { date, replacementPath });
  if (result.changed) {
    console.log(JSON.stringify({ ok: true, stamped: true, edges_archived: result.edgesArchived }));
  } else if (result.reason === 'no-frontmatter') {
    // A caller that reads {ok:true} as "already handled" and drops an
    // approved supersession is worse than one that crashes loudly: exit 1
    // so a driver treating a non-zero exit as failure-to-report catches it.
    console.log(JSON.stringify({ ok: false, stamped: false, reason: 'no-frontmatter' }));
    process.exit(1);
  } else {
    console.log(JSON.stringify({ ok: true, stamped: false, reason: 'already-invalidated' }));
  }
}
