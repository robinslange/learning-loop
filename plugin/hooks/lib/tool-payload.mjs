// hooks/lib/tool-payload.mjs : normalise a harness tool payload into file writes.
//
// Claude Code reports one file mutation per tool call: `Write` with
// {file_path, content} or `Edit` with {file_path, old_string, new_string}.
// Codex routes every mutation through `apply_patch` and reports
// tool_name: "apply_patch" with the whole patch in tool_input.command, which
// can touch several files at once.
//
// Every hook downstream of this module works in Write/Edit terms. Normalising
// here is what keeps them from having to ask which harness they are on: an
// apply_patch hunk already IS an edit, so context + `-` lines become
// old_string and context + `+` lines become new_string, which reconstructs
// against the file on disk exactly the way a real Edit does.

import { isAbsolute, resolve } from 'node:path';

const FILE_DIRECTIVE = /^\*\*\* (Add|Update|Delete) File: (.+)$/;
const MOVE_DIRECTIVE = /^\*\*\* Move to: (.+)$/;
const HUNK_HEADER = /^@@/;

/**
 * Splits an apply_patch body into Write/Edit-shaped entries.
 * @param {string} patch Raw `tool_input.command` text.
 * @param {string} cwd Session working directory; patch paths are relative to it.
 * @returns {Array<object>}
 */
function parseApplyPatch(patch, cwd) {
  const out = [];
  let file = null;
  let action = null;
  let added = [];
  let hunk = null;

  const abs = (p) => (isAbsolute(p) ? p : resolve(cwd || process.cwd(), p));

  const flushHunk = () => {
    if (!hunk || !file) return;
    out.push({
      tool: 'Edit',
      file_path: file,
      old_string: hunk.old.join('\n'),
      new_string: hunk.new.join('\n'),
    });
    hunk = null;
  };

  const flushFile = () => {
    flushHunk();
    if (file && action === 'Add') {
      out.push({ tool: 'Write', file_path: file, content: added.join('\n') });
    }
    file = null;
    action = null;
    added = [];
  };

  for (const line of String(patch || '').split('\n')) {
    const directive = FILE_DIRECTIVE.exec(line);
    if (directive) {
      flushFile();
      action = directive[1];
      file = abs(directive[2].trim());
      if (action === 'Delete') {
        out.push({ tool: 'Delete', file_path: file });
        file = null;
        action = null;
      }
      continue;
    }

    const move = MOVE_DIRECTIVE.exec(line);
    if (move) {
      // The patch keeps editing the same content under a new name; downstream
      // gates care about where the note lands, so retarget before flushing.
      flushHunk();
      file = abs(move[1].trim());
      continue;
    }

    if (line.startsWith('*** ')) {
      // Begin Patch / End Patch and any future directive.
      if (line.startsWith('*** End Patch')) flushFile();
      continue;
    }

    if (!file) continue;

    if (action === 'Add') {
      if (line.startsWith('+')) added.push(line.slice(1));
      continue;
    }

    if (HUNK_HEADER.test(line)) {
      flushHunk();
      hunk = { old: [], new: [] };
      continue;
    }

    if (!hunk) hunk = { old: [], new: [] };
    if (line.startsWith('-')) hunk.old.push(line.slice(1));
    else if (line.startsWith('+')) hunk.new.push(line.slice(1));
    else {
      const context = line.startsWith(' ') ? line.slice(1) : line;
      hunk.old.push(context);
      hunk.new.push(context);
    }
  }

  flushFile();
  return out;
}

/**
 * Normalises a raw hook payload into the file writes it performs.
 * Returns [] for tools that do not touch files.
 * @param {object} raw Parsed hook stdin.
 * @returns {Array<{tool: string, file_path: string, content?: string, old_string?: string, new_string?: string}>}
 */
export function normalizeWrites(raw) {
  const tool = raw?.tool_name;
  const input = raw?.tool_input || {};
  if (tool === 'Write' || tool === 'Edit') {
    return input.file_path ? [{ tool, ...input }] : [];
  }
  if (tool === 'apply_patch') {
    return parseApplyPatch(input.command, raw?.cwd);
  }
  return [];
}
