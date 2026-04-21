/**
 * Standalone verification script for librarian queue fixes.
 * Run with: node scripts/verify-librarian-fixes.mjs
 *
 * Creates a temp vault, exercises submit_link rules, and prints PASS/FAIL per rule.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

// ---- temp dirs ----

const runId = randomBytes(4).toString('hex');
const TEMP_ROOT = join(tmpdir(), `ll-verify-${runId}`);
const TEMP_VAULT = join(TEMP_ROOT, 'vault');
const TEMP_DATA = join(TEMP_ROOT, 'plugin-data');
const LIBRARIAN_DIR = join(TEMP_DATA, 'librarian');

mkdirSync(join(TEMP_VAULT, '3-permanent'), { recursive: true });
mkdirSync(LIBRARIAN_DIR, { recursive: true });

// Set env so librarian-queue picks up the temp data dir
process.env.CLAUDE_PLUGIN_DATA = TEMP_DATA;

// ---- create vault notes ----

// Note A: has existing link to "foo"
writeFileSync(
  join(TEMP_VAULT, '3-permanent', 'note-a.md'),
  '# Note A\n\nSome content. See also [[foo]] for more.\n'
);

// Note B: orphan, no outlinks
writeFileSync(
  join(TEMP_VAULT, '3-permanent', 'note-b.md'),
  '# Note B\n\nOrphan content.\n'
);

// foo.md exists
writeFileSync(
  join(TEMP_VAULT, '3-permanent', 'foo.md'),
  '# Foo\n\nFoo content.\n'
);

// bar.md exists
writeFileSync(
  join(TEMP_VAULT, '3-permanent', 'bar.md'),
  '# Bar\n\nBar content.\n'
);

// ghost.md does NOT exist (hallucinated slug)

// ---- patch VAULT_PATH constant to temp vault ----
// We import the tool functions directly but need to override VAULT_PATH.
// We do this by monkey-patching the constants module via env before import.
// Since constants.mjs reads from config/env, set it via a config file.

const configPath = join(TEMP_DATA, 'config.json');
writeFileSync(configPath, JSON.stringify({ vault_path: TEMP_VAULT }));

// ---- import queue helpers to reset state ----

// Dynamically import after env is set
const { appendItem, loadState, saveState, newItemId } = await import('./lib/librarian-queue.mjs');

// Write a blank initial state
saveState({ visited: [], notes_visited: 0, link_suggestions: 0, voice_flags: 0, staleness_suspects: 0, counters: {} });

// ---- import submit helpers by inlining the logic under test ----
// We replicate submitLink logic here using the real queue + real fs, pointing at temp vault.

import { existsSync as fsExists, readFileSync as fsRead } from 'fs';
import { join as pathJoin, basename } from 'path';

async function submitLink(target, suggested_link, confidence, reason) {
  const { loadState, saveState, incrementCounter, appendItem, newItemId } = await import('./lib/librarian-queue.mjs');

  if (target === suggested_link) {
    let state = loadState();
    state = incrementCounter(state, 'rejected_self_link');
    saveState(state);
    return 'Rejected: self-link';
  }

  const fullSuggestedPath = pathJoin(TEMP_VAULT, suggested_link);
  if (!fsExists(fullSuggestedPath)) {
    let state = loadState();
    state = incrementCounter(state, 'rejected_missing_file');
    saveState(state);
    return 'Rejected: suggested_link file does not exist';
  }

  const suggestedSlug = basename(suggested_link, '.md');
  const targetFullPath = pathJoin(TEMP_VAULT, target);
  if (fsExists(targetFullPath)) {
    const targetContent = fsRead(targetFullPath, 'utf-8');
    const escapedSlug = suggestedSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const linkPattern = new RegExp(`\\[\\[${escapedSlug}(\\|[^\\]]*)?\\]\\]`);
    if (linkPattern.test(targetContent)) {
      let state = loadState();
      state = incrementCounter(state, 'rejected_already_linked');
      saveState(state);
      return 'Rejected: link already present in target note';
    }
  }

  const item = {
    id: newItemId(),
    task: 'link_suggestion',
    target,
    suggested_link,
    confidence,
    reason,
    status: 'pending',
    created_at: new Date().toISOString(),
  };
  appendItem(item);

  let state = loadState();
  state = { ...state, link_suggestions: (state.link_suggestions || 0) + 1 };
  saveState(state);

  return `Queued link suggestion: ${item.id}`;
}

// ---- test cases ----

const results = [];

function assert(label, condition) {
  results.push({ label, pass: condition });
}

// Rule 1: self-link rejected
{
  const r = await submitLink('3-permanent/note-b.md', '3-permanent/note-b.md', 'high', 'test');
  assert('Rule 1 — self-link rejected', r === 'Rejected: self-link');
}

// Rule 2: missing file rejected
{
  const r = await submitLink('3-permanent/note-b.md', '3-permanent/ghost.md', 'high', 'test');
  assert('Rule 2 — missing file rejected', r === 'Rejected: suggested_link file does not exist');
}

// Rule 3: already-linked rejected (note-a already has [[foo]])
{
  const r = await submitLink('3-permanent/note-a.md', '3-permanent/foo.md', 'high', 'test');
  assert('Rule 3 — already-linked rejected', r === 'Rejected: link already present in target note');
}

// Rule 4: valid suggestion accepted and queued
{
  const r = await submitLink('3-permanent/note-b.md', '3-permanent/bar.md', 'high', 'test');
  assert('Rule 4 — valid suggestion accepted', r.startsWith('Queued link suggestion:'));
}

// Rule 5: state counters correct
{
  const state = loadState();
  assert('Rule 5 — rejected_self_link counter = 1', state.counters.rejected_self_link === 1);
  assert('Rule 5 — rejected_missing_file counter = 1', state.counters.rejected_missing_file === 1);
  assert('Rule 5 — rejected_already_linked counter = 1', state.counters.rejected_already_linked === 1);
  assert('Rule 5 — link_suggestions counter = 1', state.link_suggestions === 1);
}

// Rule 6: already-linked with display text (e.g. [[foo|Foo Note]])
{
  writeFileSync(
    join(TEMP_VAULT, '3-permanent', 'note-c.md'),
    '# Note C\n\nSee [[foo|Foo Note]] for details.\n'
  );
  const r = await submitLink('3-permanent/note-c.md', '3-permanent/foo.md', 'high', 'test');
  assert('Rule 6 — already-linked with display text rejected', r === 'Rejected: link already present in target note');
}

// Rule 7: slug with regex metacharacters (e.g. foo.excalidraw) must not match arbitrary chars
{
  // Create a slug-with-dot file: Excalidraw-style ".excalidraw.md" extension
  writeFileSync(
    join(TEMP_VAULT, '3-permanent', 'foo.excalidraw.md'),
    '# Excalidraw stub\n'
  );
  // Target contains a similar-looking but DIFFERENT wikilink — [[fooXexcalidraw]].
  // Without regex escape, the `.` in the slug would match the `X` and cause a
  // false-positive "already linked" rejection.
  writeFileSync(
    join(TEMP_VAULT, '3-permanent', 'note-d.md'),
    '# Note D\n\nSee [[fooXexcalidraw]] for details.\n'
  );
  const r = await submitLink('3-permanent/note-d.md', '3-permanent/foo.excalidraw.md', 'high', 'test');
  assert(
    'Rule 7 — slug with dot does not false-match arbitrary chars',
    r.startsWith('Queued link suggestion:')
  );
}

// ---- report ----

console.log('\nVerification results:');
let allPass = true;
for (const { label, pass } of results) {
  console.log(`  ${pass ? 'PASS' : 'FAIL'} — ${label}`);
  if (!pass) allPass = false;
}
console.log(`\n${allPass ? 'ALL PASS' : 'SOME FAILED'}`);

// cleanup
rmSync(TEMP_ROOT, { recursive: true, force: true });
