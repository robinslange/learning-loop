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

import { readFileSync, writeFileSync } from 'node:fs';
import { parseFrontmatter } from './lib/markdown-parse.mjs';
import { flagValue } from './lib/cli-args.mjs';
import { isMainModule } from './lib/is-main.mjs';

const FM_SPLIT_RE = /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)/;

/**
 * Add `invalidated:` and, when a replacement exists, `superseded_by:` to a
 * note's frontmatter, in the exact form capture-rules.md defines. A stale
 * note retired by /verify with nothing superseding it gets `invalidated:`
 * alone. Never overwrites an existing `invalidated:` -- a note already
 * superseded stays as first recorded.
 *
 * @param {string} raw the note's full text on disk
 * @param {{ date: string, replacementPath?: string }} opts
 * @returns {{ next: string, changed: boolean }}
 */
export function stampSupersession(raw, { date, replacementPath }) {
  const split = raw.match(FM_SPLIT_RE);
  if (!split) return { next: raw, changed: false };

  const { fm, body } = parseFrontmatter(raw);
  if (fm.invalidated) return { next: raw, changed: false };

  const fmLines = split[2].split(/\r?\n/).filter((l) => l.length > 0);
  fmLines.push(`invalidated: ${date}`);
  if (replacementPath) fmLines.push(`superseded_by: ${replacementPath}`);

  const next = split[1] + fmLines.join('\n') + split[3] + body;
  return { next, changed: true };
}

/**
 * Stamp a note on disk. Returns the same shape as stampSupersession; writes
 * only when changed.
 *
 * @param {string} filePath absolute path to the note being superseded
 * @param {{ date: string, replacementPath?: string }} opts
 */
export function supersedeNoteFile(filePath, opts) {
  const raw = readFileSync(filePath, 'utf-8');
  const result = stampSupersession(raw, opts);
  if (result.changed) writeFileSync(filePath, result.next);
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
  const result = supersedeNoteFile(filePath, { date, replacementPath });
  console.log(
    JSON.stringify(
      result.changed
        ? { ok: true, stamped: true }
        : { ok: true, stamped: false, reason: 'already invalidated' },
    ),
  );
}
