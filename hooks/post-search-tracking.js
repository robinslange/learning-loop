#!/usr/bin/env node
// post-search-tracking.js — Track episodic memory search queries
// and annotate results when the query matches a superseded pattern.

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { runHook, emitRetrieval, resolvePluginData } from './lib/common.mjs';
import { openEdgeDb, findMatchingSupersessions } from '../scripts/lib/edges.mjs';

async function checkSupersessions(query) {
  const pluginData = resolvePluginData();
  if (!pluginData) return null;
  const dbPath = join(pluginData, 'edges.db');
  if (!existsSync(dbPath)) return null;

  let db;
  try {
    db = await openEdgeDb(dbPath);
    const matches = findMatchingSupersessions(db, query);
    if (matches.length === 0) return null;
    const lines = matches.map(m => {
      const replacement = m.replacement_note_path
        ? ` → see [[${m.replacement_note_path.replace(/\.md$/, '').split('/').pop()}]]`
        : '';
      const reason = m.reason ? ` (${m.reason})` : '';
      return `  - "${m.old_pattern_query}" superseded ${m.superseded_date}${replacement}${reason}`;
    });
    return `Episodic search hit superseded pattern(s):\n${lines.join('\n')}\nHistorical results may be outdated; prefer the replacement note.`;
  } catch {
    return null;
  } finally {
    if (db) db.close();
  }
}

runHook(async ({ tool, input }) => {
  const query = input.query || input.message || input.text || '';
  if (query) emitRetrieval('episodic-queries', { type: 'episodic-search', tool, query });

  if (!query) return;
  const annotation = await checkSupersessions(query);
  if (annotation) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: annotation,
      },
    }));
  }
});
