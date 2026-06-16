// scripts/librarian/tools/duplicate.mjs : duplicate detection classifier for the librarian.
//
// duplicateCheck compares a note against its nearest neighbours using ollama structured
// output. submitDuplicateFlag enqueues a duplicate_flag item.
//
// deps injection pattern (duplicateCheck second arg) must be preserved:
//   tests pass { bodyOverride, neighboursOverride }.
//
// When bodyOverride is undefined (not null), readNoteBody falls back to reading
// the file from VAULT_PATH (same behaviour as original librarian.mjs).

import { readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { appendItem, newItemId, loadState, saveState, incrementCounter } from '../queue.mjs';
import { DB_PATH } from '../../lib/constants.mjs';
import { stripFrontmatter } from '../../lib/markdown-parse.mjs';
import { getVaultPath } from '../../lib/config.mjs';
import { logError } from '../../lib/log.mjs';
import { DEFAULT_MODEL, DEFAULT_OLLAMA_URL } from '../../lib/defaults.mjs';

const DEFAULT_DUPLICATE_PROMPT = `You compare an Obsidian note against its nearest neighbour to detect duplicates.

"duplicate" = both notes make the SAME core claim, even if worded differently.
"same_topic" = notes cover the same domain but make DIFFERENT claims or arguments.
"unrelated" = no meaningful overlap.

Most neighbours will be same_topic, not duplicate. True duplicates are rare.
Only answer "duplicate" if the claims are interchangeable.`;

function defaultReadNoteBody(notePath, maxChars = 500) {
  const vaultPath = getVaultPath();
  if (!vaultPath) return null;
  const fullPath = join(vaultPath, notePath);
  if (!existsSync(fullPath)) return null;
  const content = stripFrontmatter(readFileSync(fullPath, 'utf-8'));
  return content.trim().slice(0, maxChars);
}

/**
 * Check if a note is a duplicate of any of its nearest neighbours.
 * Enqueues a duplicate_flag if the model says "duplicate".
 *
 * @param {string} notePath
 * @param {{
 *   ollamaUrl?: string,
 *   model?: string,
 *   duplicatePrompt?: string,
 *   bodyOverride?: string | null,
 *   neighboursOverride?: object[],
 *   fetchOverride?: typeof fetch,
 *   readNoteBodyFn?: (path: string) => string | null,
 *   logFn?: (msg: string) => void,
 * }} [deps]
 */
export async function duplicateCheck(notePath, deps = {}) {
  const {
    ollamaUrl = DEFAULT_OLLAMA_URL,
    model = DEFAULT_MODEL,
    duplicatePrompt = DEFAULT_DUPLICATE_PROMPT,
    bodyOverride,
    neighboursOverride,
    fetchOverride,
    readNoteBodyFn,
    logFn,
  } = deps;

  const fetchFn = fetchOverride || globalThis.fetch;
  const log = logFn || (() => {});
  const readBody = readNoteBodyFn || defaultReadNoteBody;

  const body = bodyOverride !== undefined ? bodyOverride : readBody(notePath);
  if (!body) return;

  let neighbours;
  if (neighboursOverride) {
    neighbours = neighboursOverride;
  } else {
    const { run } = await import('../../lib/binary.mjs');
    try {
      neighbours = run(['similar', DB_PATH, notePath, '--top', '3']);
    } catch (err) {
      log('duplicateCheck similar error for ' + notePath + ': ' + err.message + '\n');
      return;
    }
  }
  if (!neighbours || !neighbours.length) return;

  const title = basename(notePath, '.md');
  const neighbourBlocks = neighbours
    .map((n, i) => {
      const nTitle = basename(n.path, '.md');
      const nBody = readBody(n.path) || '(empty)';
      return (
        'Neighbour ' +
        (i + 1) +
        ' (similarity ' +
        n.score.toFixed(3) +
        ', path ' +
        n.path +
        '): "' +
        nTitle +
        '"\n' +
        nBody
      );
    })
    .join('\n\n');

  const userContent =
    'Note (path ' + notePath + '): "' + title + '"\n' + body + '\n\n' + neighbourBlocks;

  let resp;
  try {
    resp = await fetchFn(`${ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: duplicatePrompt },
          { role: 'user', content: userContent },
        ],
        format: {
          type: 'object',
          properties: {
            relationship: {
              type: 'string',
              enum: ['duplicate', 'same_topic', 'unrelated'],
            },
            duplicate_of: { type: ['string', 'null'] },
          },
          required: ['relationship', 'duplicate_of'],
        },
        options: { temperature: 0 },
        stream: false,
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    const kind = err.name === 'TimeoutError' || err.name === 'AbortError' ? 'timeout' : 'network';
    log('duplicateCheck ' + kind + ' for ' + notePath + ': ' + err.message + '\n');
    return;
  }
  if (!resp.ok) {
    log('duplicateCheck HTTP ' + resp.status + ' for ' + notePath + '\n');
    return;
  }
  try {
    const { message } = await resp.json();
    const parsed = JSON.parse(message.content);
    if (parsed.relationship !== 'duplicate') return;
    const claimed = parsed.duplicate_of;
    const match = neighbours.find((n) => n.path === claimed || basename(n.path, '.md') === claimed);
    if (!match) {
      log(
        'duplicateCheck: model named non-neighbour ' +
          claimed +
          ' for ' +
          notePath +
          ', skipping\n',
      );
      return;
    }
    await submitDuplicateFlag({
      target: notePath,
      duplicate_of: match.path,
      similarity: match.score,
      reason: 'duplicate classifier (structured output)',
    });
  } catch (err) {
    log('duplicateCheck parse error for ' + notePath + ': ' + err.message + '\n');
  }
}

/**
 * Enqueue a duplicate_flag item.
 * Rejects self-duplicates.
 *
 * @param {{ target: string, duplicate_of: string, similarity?: number, reason?: string }} item
 * @returns {Promise<string>}
 */
export async function submitDuplicateFlag({ target, duplicate_of, similarity, reason }) {
  if (target === duplicate_of) {
    let state = loadState();
    state = incrementCounter(state, 'rejected_self_duplicate');
    saveState(state);
    return 'Rejected: self-duplicate';
  }

  const item = {
    id: newItemId(),
    task: 'duplicate_flag',
    target,
    duplicate_of,
    similarity: typeof similarity === 'number' ? similarity : null,
    reason: reason || 'classifier flag',
    status: 'pending',
    created_at: new Date().toISOString(),
  };
  appendItem(item);

  let state = loadState();
  state = { ...state, duplicate_flags: (state.duplicate_flags || 0) + 1 };
  saveState(state);

  return 'Queued duplicate flag: ' + item.id;
}
