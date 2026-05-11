// scripts/librarian/config.mjs : librarian-specific config loader with mtime+inode cache.
//
// Wraps getConfig() from scripts/lib/config.mjs. Adds a process-lifetime cache
// invalidated by mtime+inode so symlink rotations are handled correctly.
//
// env.OLLAMA_URL is consulted BEFORE libCfg.ollama_url (semantic widening vs.
// original librarian.mjs which only read libCfg.ollama_url).
//
// Ollama timeouts live here (not in HookConfig) — they are librarian-specific.
// Prompts and STRUCTURAL_TAGS are co-located to keep tool modules slim.

import { statSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig, getPluginData } from '../lib/config.mjs';
import { env } from '../lib/env.mjs';
import { logError } from '../lib/log.mjs';

let _cache = null;
let _cacheKey = '';

/**
 * Load librarian config, cached by mtime+inode of the config file.
 * Returns a frozen object; call resetCache() in tests for isolation.
 *
 * @param {{ configPath?: string, now?: number }} [opts] - for test injection
 * @returns {LibrarianConfig}
 */
export function loadLibrarianConfig({ configPath, now: _now } = {}) {
  const cfgPath =
    configPath ||
    (() => {
      const pd = getPluginData();
      return pd ? join(pd, 'config.json') : null;
    })();

  if (cfgPath) {
    try {
      const st = statSync(cfgPath);
      const key = `${st.mtimeMs}-${st.ino}`;
      if (_cache && _cacheKey === key) return _cache;
      _cacheKey = key;
    } catch (e) {
      logError('librarian-config', e);
    }
  }

  const cfg = getConfig();
  const libCfg = cfg.librarian || {};

  const result = Object.freeze({
    enabled: libCfg.enabled !== false,
    model: libCfg.model || env.MODEL || 'gemma4:e2b',
    paceMs: (libCfg.pace_seconds || 2) * 1000,
    queueCap: libCfg.queue_cap || 200,
    // env.OLLAMA_URL takes precedence over libCfg.ollama_url (semantic widening: PR note)
    ollamaUrl: env.OLLAMA_URL || libCfg.ollama_url || 'http://localhost:11434',
    pauseOnBattery: libCfg.pause_on_battery !== false,
    batteryPollMs: (libCfg.battery_poll_seconds || 60) * 1000,
    linkPrompt: libCfg.link_prompt || LINK_PROMPT,
    voicePrompt: libCfg.voice_prompt || VOICE_PROMPT,
    tagPrompt: libCfg.tag_prompt || TAG_PROMPT,
    duplicatePrompt: libCfg.duplicate_prompt || DUPLICATE_PROMPT,
    structuralTags: new Set(libCfg.structural_tags || DEFAULT_STRUCTURAL_TAGS),
  });

  _cache = result;
  return result;
}

/** Reset the in-process cache — call in tests for isolation. */
export function __test_resetCache() {
  _cache = null;
  _cacheKey = '';
}

// Expose for tests without a named export collision
export const __test__ = { resetCache: __test_resetCache };

const DEFAULT_STRUCTURAL_TAGS = ['literature', 'counterpoint', 'synthesis', 'excalidraw'];

const LINK_PROMPT = `You are a vault librarian. You wander through a knowledge vault, noticing things that need attention.

Right now you're looking at one note. Your tools let you check its neighborhood in the link graph.

For LINK INVESTIGATION (notes with 0 inlinks):
1. find_similar to see what's nearby
2. get_inlinks on neighbors to understand the local cluster
3. read_note on the orphan + best neighbor
4. submit_link if a reader would benefit from the cross-reference

Be liberal -- same domain = related. Different mechanisms within one field ARE connected.

You do NOT investigate staleness yourself. If something seems off, submit_suspect and move on. Claude will handle the deep investigation.`;

const VOICE_PROMPT = `Classify this Obsidian note title as "claim" (states an assertion that could be true or false) or "topic" (names a domain, concept, or entity without stating a relationship). A claim contains a verb or claim connective; a topic is a noun phrase without one. When in doubt, answer "claim".`;

const TAG_PROMPT = `You add tags to an Obsidian note. The tags must come from the supplied vocabulary list.

Output 0, 1, or 2 tags. Two is the maximum.

Choose tags that name the SPECIFIC subject matter of THIS note's body. The body is short; read it.

Do NOT add a tag because it is general or familiar. Do NOT pad to two tags. If only one tag clearly fits, return that one alone. If no tag from the vocabulary clearly applies to this note's specific subject, return an empty array.

Tags like "cognition", "design", or "psychology" are usually too broad. Prefer narrower tags ("pharmacology", "neuroscience", "habit-formation") whenever they fit.`;

const DUPLICATE_PROMPT = `You compare an Obsidian note against its nearest neighbour to detect duplicates.

"duplicate" = both notes make the SAME core claim, even if worded differently.
"same_topic" = notes cover the same domain but make DIFFERENT claims or arguments.
"unrelated" = no meaningful overlap.

Most neighbours will be same_topic, not duplicate. True duplicates are rare.
Only answer "duplicate" if the claims are interchangeable.`;
