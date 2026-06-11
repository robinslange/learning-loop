// scripts/librarian/tools/tag-suggest.mjs : tag suggestion classifier for the librarian.
//
// tagCheck reads the note body + existing tags + vocabulary, calls ollama structured
// output, and enqueues a tag_suggestion item if new tags are proposed.
//
// deps injection pattern (tagCheck second arg) must be preserved:
//   tests pass { bodyOverride, existingTagsOverride, vocabularyOverride }.

import { basename } from 'node:path';
import { appendItem, newItemId, loadState, saveState } from '../queue.mjs';
import { logError } from '../../lib/log.mjs';

const DEFAULT_TAG_PROMPT = `You add tags to an Obsidian note. The tags must come from the supplied vocabulary list.

Output 0, 1, or 2 tags. Two is the maximum.

Choose tags that name the SPECIFIC subject matter of THIS note's body. The body is short; read it.

Do NOT add a tag because it is general or familiar. Do NOT pad to two tags. If only one tag clearly fits, return that one alone. If no tag from the vocabulary clearly applies to this note's specific subject, return an empty array.

Tags like "cognition", "design", or "psychology" are usually too broad. Prefer narrower tags ("pharmacology", "neuroscience", "habit-formation") whenever they fit.`;

/**
 * Suggest tags for a note via ollama structured output.
 * Enqueues a tag_suggestion if new tags are proposed.
 *
 * @param {string} notePath
 * @param {{
 *   ollamaUrl?: string,
 *   model?: string,
 *   tagPrompt?: string,
 *   bodyOverride?: string | null,
 *   existingTagsOverride?: string,
 *   vocabularyOverride?: string[],
 *   fetchOverride?: typeof fetch,
 *   getDb?: () => Promise<object>,
 *   logFn?: (msg: string) => void,
 * }} [deps]
 */
export async function tagCheck(notePath, deps = {}) {
  const {
    ollamaUrl = 'http://localhost:11434',
    model = 'gemma4:e2b',
    tagPrompt = DEFAULT_TAG_PROMPT,
    bodyOverride,
    existingTagsOverride,
    vocabularyOverride,
    fetchOverride,
    getDb,
    readNoteBody,
    logFn,
  } = deps;

  const fetchFn = fetchOverride || globalThis.fetch;
  const log = logFn || (() => {});

  const body =
    bodyOverride !== undefined ? bodyOverride : readNoteBody ? readNoteBody(notePath) : null;
  if (!body) return;

  let existingTags;
  if (existingTagsOverride !== undefined) {
    existingTags = existingTagsOverride;
  } else if (getDb) {
    const db = await getDb();
    const tagRow = db.exec('SELECT tags FROM notes WHERE path = ?', [notePath]);
    existingTags = tagRow.length && tagRow[0].values.length ? tagRow[0].values[0][0] || '' : '';
  } else {
    existingTags = '';
  }

  const vocabulary = vocabularyOverride || [];
  if (!vocabulary.length) return;

  const title = basename(notePath, '.md');
  const userContent =
    'Title: ' +
    title +
    '\nExisting tags: ' +
    (existingTags || '(none)') +
    '\nBody:\n' +
    body +
    '\n\nVocabulary (tags you may use, nothing else): ' +
    vocabulary.join(', ');

  let resp;
  try {
    resp = await fetchFn(`${ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: tagPrompt },
          { role: 'user', content: userContent },
        ],
        format: {
          type: 'object',
          properties: {
            suggested_tags: {
              type: 'array',
              items: { type: 'string' },
              maxItems: 2,
            },
          },
          required: ['suggested_tags'],
        },
        options: { temperature: 0 },
        stream: false,
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    const kind = err.name === 'TimeoutError' || err.name === 'AbortError' ? 'timeout' : 'network';
    log('tagCheck ' + kind + ' for ' + notePath + ': ' + err.message + '\n');
    return;
  }
  if (!resp.ok) {
    log('tagCheck HTTP ' + resp.status + ' for ' + notePath + '\n');
    return;
  }
  try {
    const { message } = await resp.json();
    const parsed = JSON.parse(message.content);
    const existingSet = new Set(existingTags.split(' ').filter(Boolean));
    const vocabSet = new Set(vocabulary);
    const cleaned = [
      ...new Set(
        (parsed.suggested_tags || []).filter((t) => vocabSet.has(t) && !existingSet.has(t)),
      ),
    ].slice(0, 2);
    if (cleaned.length === 0) return;
    await submitTagSuggestion({
      target: notePath,
      suggested_tags: cleaned,
      existing_tags: existingTags,
      reason: 'tag classifier (gemma4:e2b structured output)',
    });
  } catch (err) {
    log('tagCheck parse error for ' + notePath + ': ' + err.message + '\n');
  }
}

/**
 * Enqueue a tag_suggestion item.
 * @param {{ target: string, suggested_tags: string[], existing_tags: string, reason?: string }} item
 * @returns {Promise<string>}
 */
export async function submitTagSuggestion({ target, suggested_tags, existing_tags, reason }) {
  const item = {
    id: newItemId(),
    task: 'tag_suggestion',
    target,
    suggested_tags,
    existing_tags: existing_tags || '',
    reason: reason || 'classifier suggestion',
    status: 'pending',
    created_at: new Date().toISOString(),
  };
  appendItem(item);

  let state = loadState();
  state = { ...state, tag_suggestions: (state.tag_suggestions || 0) + 1 };
  saveState(state);

  return 'Queued tag suggestion: ' + item.id;
}
