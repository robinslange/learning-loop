#!/usr/bin/env node
// post-search-tracking.js — Track episodic memory search queries
// and annotate results when the query matches a superseded pattern.

import { existsSync } from 'node:fs';
import { runHook, emitRetrieval, resolvePluginData } from './lib/common.mjs';
import { loadSupersessionsCached, matchSupersessions } from '../scripts/lib/edges.mjs';
import { logError } from '../scripts/lib/log.mjs';
import { emitJson } from './lib/io.mjs';
import { DATA_FILES } from '../scripts/lib/paths.mjs';

async function checkSupersessions(query) {
  const pluginData = resolvePluginData();
  if (!pluginData) return null;
  const dbPath = DATA_FILES.edgesDb(pluginData);
  if (!existsSync(dbPath)) return null;

  try {
    // Sidecar-cached read: sql.js only boots when edges.db changed since the
    // last read; the steady state is two stats + a tiny JSON parse per call.
    const rows = await loadSupersessionsCached(dbPath);
    const matches = matchSupersessions(rows, query);
    if (matches.length === 0) return null;
    const lines = matches.map((m) => {
      const replacement = m.replacement_note_path
        ? ` → see [[${m.replacement_note_path.replace(/\.md$/, '').split('/').pop()}]]`
        : '';
      const reason = m.reason ? ` (${m.reason})` : '';
      return `  - "${m.old_pattern_query}" superseded ${m.superseded_date}${replacement}${reason}`;
    });
    return `Episodic search hit superseded pattern(s):\n${lines.join('\n')}\nHistorical results may be outdated; prefer the replacement note.`;
  } catch (err) {
    logError('post-search-tracking.checkSupersessions', err);
    return null;
  }
}

runHook(async ({ tool, input }) => {
  const raw = input.query || input.message || input.text || '';
  const query = Array.isArray(raw) ? raw.join(' ') : raw;
  if (query) emitRetrieval('episodic-queries', { type: 'episodic-search', tool, query });

  if (!query) return;
  const annotation = await checkSupersessions(query);
  if (annotation) {
    emitJson({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: annotation,
      },
    });
  }
});
