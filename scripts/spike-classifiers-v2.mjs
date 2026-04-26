#!/usr/bin/env node
/**
 * Spike v2: duplicate detector + tag suggester with pre-fetched body context.
 *
 * Changes from v1:
 * - Duplicate: feeds body of candidate + neighbours, uses 3-way enum
 * - Tags: constrains to maxItems 3, tighter prompt
 *
 * Usage: node scripts/spike-classifiers-v2.mjs [--sample N] [--only duplicate|tags]
 */

import { readFileSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { getPluginData } from './lib/config.mjs';
import { openReadonly } from './lib/sqljs.mjs';
import { run } from './lib/binary.mjs';

const VAULT_PATH = process.env.VAULT_PATH || join(process.env.HOME, 'brain', 'brain');
const PLUGIN_DATA = getPluginData();
const DB_PATH = join(PLUGIN_DATA, 'search.db');
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const MODEL = process.env.MODEL || 'gemma4:e2b';

const args = process.argv.slice(2);
const sampleSize = parseInt(args.find((_, i, a) => a[i - 1] === '--sample') || '30');
const only = args.find((_, i, a) => a[i - 1] === '--only') || null;

async function ollamaChat(systemPrompt, userContent, format, options = {}) {
  const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      format,
      options: { temperature: 0, ...options },
      stream: false,
    }),
  });
  if (!resp.ok) throw new Error(`ollama HTTP ${resp.status}`);
  const { message } = await resp.json();
  return JSON.parse(message.content);
}

function readNoteBody(notePath, maxChars = 500) {
  const fullPath = join(VAULT_PATH, notePath);
  if (!existsSync(fullPath)) return null;
  let content = readFileSync(fullPath, 'utf-8');
  if (content.startsWith('---')) {
    const end = content.indexOf('\n---', 3);
    if (end !== -1) content = content.slice(end + 4);
  }
  return content.trim().slice(0, maxChars);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---- Duplicate Detector v2 ----

const DUPLICATE_PROMPT = `You compare an Obsidian note against its nearest neighbours to detect duplicates.

"duplicate" = both notes make the SAME core claim, even if worded differently.
"same_topic" = notes cover the same domain but make DIFFERENT claims or arguments.
"unrelated" = no meaningful overlap.

Most neighbours will be same_topic, not duplicate. True duplicates are rare.
Only answer "duplicate" if the claims are interchangeable.`;

const DUPLICATE_FORMAT = {
  type: 'object',
  properties: {
    relationship: {
      type: 'string',
      enum: ['duplicate', 'same_topic', 'unrelated'],
    },
    duplicate_of: { type: ['string', 'null'] },
  },
  required: ['relationship', 'duplicate_of'],
};

async function spikeDuplicate(db) {
  const rows = db.exec('SELECT path FROM notes');
  if (!rows.length) return [];
  const paths = shuffle(rows[0].values.map((r) => r[0])).slice(0, sampleSize);
  const results = [];

  for (const notePath of paths) {
    const title = basename(notePath, '.md');
    const body = readNoteBody(notePath);
    if (body === null) continue;

    let neighbours;
    try {
      neighbours = run(['similar', DB_PATH, notePath, '--top', '3']);
    } catch {
      continue;
    }
    if (!neighbours || !neighbours.length) continue;

    const neighbourBlocks = neighbours.map((n, i) => {
      const nTitle = basename(n.path, '.md');
      const nBody = readNoteBody(n.path) || '(empty)';
      return `Neighbour ${i + 1} (similarity ${n.score.toFixed(3)}): "${nTitle}"\n${nBody}`;
    });

    const userContent = `Note: "${title}"\n${body}\n\n${neighbourBlocks.join('\n\n')}`;

    try {
      const result = await ollamaChat(DUPLICATE_PROMPT, userContent, DUPLICATE_FORMAT);
      results.push({
        path: notePath,
        title,
        neighbours: neighbours.map((n) => ({
          path: n.path,
          title: basename(n.path, '.md'),
          score: n.score,
        })),
        ...result,
      });
      process.stderr.write(`  dup: ${title.slice(0, 45).padEnd(45)} -> ${result.relationship}\n`);
    } catch (err) {
      process.stderr.write(`  dup error: ${title.slice(0, 45)}: ${err.message}\n`);
    }
  }
  return results;
}

// ---- Tag Suggester v3 ----
//
// v2 result: 21/30 notes received "cognition" as one of 3 suggested tags,
// even though "cognition" is only 1.9% of vault tags. The model used the third
// slot for filler. Fixes:
// - maxItems: 2 (no third filler slot)
// - allow empty array (no tag must apply)
// - temperature: 0 (deterministic, no creative wandering)
// - prompt: anchor to body, forbid filler, treat the vocabulary as a fence
// - post-hoc batch-overuse filter as a safety net

const TAG_PROMPT = `You add tags to an Obsidian note. The tags must come from the supplied vocabulary list.

Output 0, 1, or 2 tags. Two is the maximum.

Choose tags that name the SPECIFIC subject matter of THIS note's body. The body is short; read it.

Do NOT add a tag because it is general or familiar. Do NOT pad to two tags. If only one tag clearly fits, return that one alone. If no tag from the vocabulary clearly applies to this note's specific subject, return an empty array.

Tags like "cognition", "design", or "psychology" are usually too broad. Prefer narrower tags ("pharmacology", "neuroscience", "habit-formation") whenever they fit.`;

const TAG_FORMAT = {
  type: 'object',
  properties: {
    suggested_tags: {
      type: 'array',
      items: { type: 'string' },
      maxItems: 2,
    },
  },
  required: ['suggested_tags'],
};

function buildTagVocabulary(db) {
  const tagRows = db.exec("SELECT tags FROM notes WHERE tags != ''");
  const tagCounts = {};
  if (tagRows.length) {
    for (const [tagStr] of tagRows[0].values) {
      for (const t of tagStr.split(' ').filter(Boolean)) {
        tagCounts[t] = (tagCounts[t] || 0) + 1;
      }
    }
  }
  const ranked = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]);
  const STRUCTURAL = new Set(['literature', 'counterpoint', 'synthesis', 'excalidraw']);
  return ranked
    .filter(([t, n]) => n >= 3 && !STRUCTURAL.has(t) && !t.startsWith('project/'))
    .slice(0, 60)
    .map(([t]) => t);
}

async function spikeTags(db) {
  const vocabulary = buildTagVocabulary(db);

  const rows = db.exec('SELECT path, tags FROM notes');
  if (!rows.length) return [];
  const candidates = rows[0].values
    .map((r) => ({ path: r[0], tags: r[1] }))
    .filter((n) => !n.tags || n.tags.split(' ').filter(Boolean).length <= 1);
  const paths = shuffle(candidates).slice(0, sampleSize);
  const results = [];

  for (const { path: notePath, tags: existingTags } of paths) {
    const title = basename(notePath, '.md');
    const body = readNoteBody(notePath);
    if (body === null) continue;

    const userContent = `Title: ${title}\nExisting tags: ${existingTags || '(none)'}\nBody:\n${body}\n\nVocabulary (tags you may use, nothing else): ${vocabulary.join(', ')}`;

    try {
      const result = await ollamaChat(TAG_PROMPT, userContent, TAG_FORMAT);
      const existingSet = new Set((existingTags || '').split(' ').filter(Boolean));
      const vocabSet = new Set(vocabulary);
      const cleaned = [
        ...new Set(
          (result.suggested_tags || []).filter((t) => vocabSet.has(t) && !existingSet.has(t)),
        ),
      ].slice(0, 2);
      results.push({
        path: notePath,
        title,
        existing_tags: existingTags || '',
        suggested_tags: cleaned,
        raw_suggested_tags: result.suggested_tags || [],
      });
      process.stderr.write(`  tag: ${title.slice(0, 45)} -> [${cleaned.join(', ')}]\n`);
    } catch (err) {
      process.stderr.write(`  tag error: ${title.slice(0, 45)}: ${err.message}\n`);
    }
  }

  const counts = {};
  for (const r of results) {
    for (const t of r.suggested_tags) counts[t] = (counts[t] || 0) + 1;
  }
  const threshold = Math.ceil(results.length * 0.5);
  const overused = Object.entries(counts)
    .filter(([, n]) => n > threshold)
    .map(([t]) => t);
  if (overused.length) {
    process.stderr.write(
      `  filler filter: dropping overused tags ${overused.join(', ')} (>${threshold} of ${results.length})\n`,
    );
    for (const r of results) {
      r.suggested_tags = r.suggested_tags.filter((t) => !overused.includes(t));
    }
  }
  return results;
}

// ---- Main ----

async function main() {
  const db = await openReadonly(DB_PATH);
  const output = {};

  if (!only || only === 'duplicate') {
    process.stderr.write(
      `\n=== Duplicate Detector v2 (${sampleSize} notes, with body context) ===\n`,
    );
    output.duplicate = await spikeDuplicate(db);
    const counts = { duplicate: 0, same_topic: 0, unrelated: 0 };
    for (const r of output.duplicate) counts[r.relationship] = (counts[r.relationship] || 0) + 1;
    process.stderr.write(
      `\nDuplicates: ${counts.duplicate} dup, ${counts.same_topic} same_topic, ${counts.unrelated} unrelated (of ${output.duplicate.length})\n`,
    );
  }

  if (!only || only === 'tags') {
    process.stderr.write(
      `\n=== Tag Suggester v2 (${sampleSize} under-tagged notes, max 3 tags) ===\n`,
    );
    output.tags = await spikeTags(db);
    const taggedCount = output.tags.filter((r) => r.suggested_tags.length > 0).length;
    const avgTags =
      output.tags.reduce((s, r) => s + r.suggested_tags.length, 0) / (output.tags.length || 1);
    process.stderr.write(
      `\nTags: ${taggedCount}/${output.tags.length} got suggestions, avg ${avgTags.toFixed(1)} tags/note\n`,
    );
  }

  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
