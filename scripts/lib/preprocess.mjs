import { readFileSync } from 'fs';
import { basename } from 'path';
import { createHash } from 'crypto';
import { MAX_TEXT_LENGTH, VAULT_PATH } from './constants.mjs';

export function preprocessNote(raw, filename) {
  const title = basename(filename, '.md').replace(/-/g, ' ');

  // Extract tags from frontmatter
  let tags = '';
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const tagMatch = fmMatch[1].match(/tags:\s*\[([^\]]*)\]/);
    if (tagMatch) tags = tagMatch[1].replace(/,\s*/g, ' ').trim();
  }

  // Strip frontmatter
  const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
  if (!body) return null;

  // Strip wikilinks: [[foo|bar]] -> bar, [[foo]] -> foo
  const cleaned = body
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1');

  // Build embedding text
  let text = `Title: ${title}\n\n${cleaned}`;
  if (tags) text += `\n\nTags: ${tags.split(/\s+/).map(t => `#${t}`).join(' ')}`;
  text = text.slice(0, MAX_TEXT_LENGTH);

  return { title, tags, body: cleaned, text };
}

export function preprocessExcalidraw(raw, filename) {
  const title = basename(filename, '.excalidraw.md').replace(/-/g, ' ');

  const jsonMatch = raw.match(/```json\n([\s\S]*?)\n```/);
  if (!jsonMatch) return null;

  let data;
  try {
    data = JSON.parse(jsonMatch[1]);
  } catch {
    return null;
  }

  const texts = (data.elements || [])
    .filter(el => el.type === 'text' && el.text && !el.isDeleted)
    .map(el => el.text);

  if (texts.length === 0) return null;

  const body = texts.join('\n');
  let text = `Title: ${title}\n\n${body}`;
  text = text.slice(0, MAX_TEXT_LENGTH);

  return { title, tags: 'excalidraw', body, text };
}

export function preprocessFile(filepath) {
  let raw;
  try {
    raw = readFileSync(filepath, 'utf-8');
  } catch {
    return null;
  }

  const filename = basename(filepath);
  if (filename.endsWith('.excalidraw.md')) {
    return preprocessExcalidraw(raw, filename);
  }
  return preprocessNote(raw, filename);
}

export function contentHash(text) {
  return createHash('sha256').update(text).digest('hex');
}

// Inline tests
if (process.argv.includes('--test')) {
  let passed = 0;
  let failed = 0;

  function assert(condition, name) {
    if (condition) { passed++; }
    else { failed++; console.error(`FAIL: ${name}`); }
  }

  // Frontmatter stripping
  const withFm = '---\ntags: [search, ml]\ndate: 2026-01-01\n---\n\nBody text here.';
  const r1 = preprocessNote(withFm, 'test-note.md');
  assert(r1.body === 'Body text here.', 'frontmatter stripped, body preserved');
  assert(r1.tags === 'search ml', 'tags extracted');
  assert(r1.title === 'test note', 'title from filename slug');
  assert(r1.text.startsWith('Title: test note\n\n'), 'title prepended');
  assert(r1.text.includes('Tags: #search #ml'), 'tags appended');

  // No frontmatter
  const noFm = 'Just a body with no frontmatter.';
  const r2 = preprocessNote(noFm, 'simple.md');
  assert(r2.body === 'Just a body with no frontmatter.', 'no frontmatter handled');
  assert(r2.tags === '', 'no tags = empty string');

  // Wikilinks
  const withLinks = '---\ntags: []\n---\n\nSee [[some-note]] and [[other|display text]] for details.';
  const r3 = preprocessNote(withLinks, 'links.md');
  assert(r3.body === 'See some-note and display text for details.', 'wikilinks cleaned');

  // Empty body
  const emptyBody = '---\ntags: [test]\n---\n\n';
  const r4 = preprocessNote(emptyBody, 'empty.md');
  assert(r4 === null, 'empty body returns null');

  // Excalidraw
  const excalidrawRaw = `---
excalidraw-plugin: parsed
---

## Drawing
\`\`\`json
{
  "type": "excalidraw",
  "elements": [
    {"type": "text", "text": "Box A", "isDeleted": false},
    {"type": "rectangle", "isDeleted": false},
    {"type": "text", "text": "Box B", "isDeleted": false},
    {"type": "text", "text": "Deleted", "isDeleted": true}
  ]
}
\`\`\``;
  const r5 = preprocessExcalidraw(excalidrawRaw, 'diagram.excalidraw.md');
  assert(r5 !== null, 'excalidraw parsed');
  assert(r5.body === 'Box A\nBox B', 'excalidraw text extracted, deleted filtered');
  assert(r5.title === 'diagram', 'excalidraw title from filename');

  // Hash stability
  const h1 = contentHash('hello world');
  const h2 = contentHash('hello world');
  const h3 = contentHash('hello world!');
  assert(h1 === h2, 'same input = same hash');
  assert(h1 !== h3, 'different input = different hash');

  // Real vault note
  const { join } = await import('path');
  const realResult = preprocessFile(join(VAULT_PATH, '3-permanent', 'caffeine-acute-pk-profile.md'));
  assert(realResult !== null, 'real vault note preprocessed');
  assert(realResult.title.length > 0, 'real note has title');

  // Real excalidraw
  const exResult = preprocessFile(join(VAULT_PATH, 'Excalidraw', 'vault-embedding-pipeline.excalidraw.md'));
  assert(exResult !== null, 'real excalidraw preprocessed');
  assert(exResult.body.length > 0, 'excalidraw has text content');

  console.error(`\nPreprocess tests: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}
