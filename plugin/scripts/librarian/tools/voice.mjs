// scripts/librarian/tools/voice.mjs : voice gate classifier for the librarian.
//
// voiceCheck classifies a note title as "claim" or "topic" via structured ollama output.
// submitVoiceFlag enqueues a voice_flag item in the persistent queue.
//
// deps injection pattern (voiceCheck second arg) must be preserved:
//   tests in voice-gate.test.mjs pass { fetchOverride } to mock fetch.

import { basename } from 'node:path';
import { appendItem, newItemId, loadState, saveState } from '../queue.mjs';
import { logError } from '../../lib/log.mjs';
import { DEFAULT_MODEL, DEFAULT_OLLAMA_URL } from '../../lib/defaults.mjs';
import { chatJSON } from '../../lib/model-client.mjs';

/**
 * Classify a note title as "claim" or "topic" using ollama structured output.
 * Enqueues a voice_flag if the model returns "topic".
 *
 * @param {string} notePath
 * @param {{
 *   ollamaUrl?: string,
 *   model?: string,
 *   voicePrompt?: string,
 *   fetchOverride?: typeof fetch,
 *   logFn?: (msg: string) => void,
 * }} [deps]
 */
export async function voiceCheck(notePath, deps = {}) {
  const title = basename(notePath, '.md');
  const {
    ollamaUrl = DEFAULT_OLLAMA_URL,
    model = DEFAULT_MODEL,
    voicePrompt,
    fetchOverride,
    logFn,
  } = deps;
  const provider = deps.provider || { kind: 'ollama', baseUrl: ollamaUrl, model };

  const VOICE_PROMPT =
    voicePrompt ||
    'Classify this Obsidian note title as "claim" (states an assertion that could be true or false) or "topic" (names a domain, concept, or entity without stating a relationship). A claim contains a verb or claim connective; a topic is a noun phrase without one. When in doubt, answer "claim".';

  const log = logFn || (() => {});

  let label;
  try {
    ({ label } = await chatJSON({
      provider,
      model: provider.model || model,
      system: VOICE_PROMPT,
      user: 'Title: ' + title + '\nClassify:',
      schema: {
        type: 'object',
        properties: { label: { type: 'string', enum: ['claim', 'topic'] } },
        required: ['label'],
      },
      timeoutMs: 15000,
      fetchOverride,
    }));
  } catch (err) {
    const kind = err.name === 'TimeoutError' || err.name === 'AbortError' ? 'timeout' : 'error';
    log('voiceCheck ' + kind + ' for ' + notePath + ': ' + err.message + '\n');
    return;
  }
  if (label === 'topic') {
    await submitVoiceFlag({
      target: notePath,
      current_title: title,
      reason: 'topic-style title (structured-output classifier)',
    });
  }
}

/**
 * Enqueue a voice_flag item.
 * @param {{ target: string, current_title: string, reason: string }} item
 * @returns {Promise<string>} queue result message
 */
export async function submitVoiceFlag({ target, current_title, reason }) {
  const item = {
    id: newItemId(),
    task: 'voice_flag',
    target,
    current_title,
    reason,
    status: 'pending',
    created_at: new Date().toISOString(),
  };
  appendItem(item);

  let state = loadState();
  state = { ...state, voice_flags: (state.voice_flags || 0) + 1 };
  saveState(state);

  return 'Queued voice flag: ' + item.id;
}
