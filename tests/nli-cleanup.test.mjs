// Tests for scripts/nli-cleanup.mjs vault frontmatter cleanup.
//
// Two behaviors pinned here:
//   1. The vault scan is RECURSIVE within each allowlisted folder: a note in a
//      subfolder of 0-inbox must be seen (the original private walker read only
//      the folder's top level and silently skipped nested notes).
//   2. CRLF notes are handled: the frontmatter fence match is CRLF-safe and the
//      untouched remainder keeps its line endings byte-for-byte.
//
// Every run passes --db to a nonexistent temp path so the DB step skips; only
// the vault frontmatter step is exercised.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const SCRIPT = fileURLToPath(new URL('../plugin/scripts/nli-cleanup.mjs', import.meta.url));

function runCleanup(vaultRoot, extraArgs = []) {
  return execFileSync(
    'node',
    [SCRIPT, '--db', join(vaultRoot, 'no-such-edges.db'), '--vault', vaultRoot, ...extraArgs],
    { encoding: 'utf-8', timeout: 20000 },
  );
}

function setupVault() {
  const root = mkdtempSync(join(tmpdir(), 'nli-cleanup-'));
  mkdirSync(join(root, '0-inbox'), { recursive: true });
  return root;
}

test('strips NLI frontmatter from a note in a SUBFOLDER of an included dir', () => {
  const root = setupVault();
  try {
    mkdirSync(join(root, '0-inbox', 'topic'), { recursive: true });
    const note = join(root, '0-inbox', 'topic', 'nested.md');
    writeFileSync(note, '---\nname: nested\nnli_tension: 0.9\n---\n\nBody.\n');
    const out = runCleanup(root, ['--execute']);
    assert.match(out, /stripped NLI frontmatter from: .*nested\.md/);
    assert.equal(readFileSync(note, 'utf-8'), '---\nname: nested\n---\n\nBody.\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('strips NLI frontmatter from a CRLF note, preserving the rest byte-for-byte', () => {
  const root = setupVault();
  try {
    const note = join(root, '0-inbox', 'crlf.md');
    writeFileSync(note, '---\r\nname: crlf\r\nhas-contradiction: true\r\n---\r\n\r\nBody.\r\n');
    runCleanup(root, ['--execute']);
    assert.equal(readFileSync(note, 'utf-8'), '---\r\nname: crlf\r\n---\r\n\r\nBody.\r\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('dry-run (default) reports but does not write', () => {
  const root = setupVault();
  try {
    const note = join(root, '0-inbox', 'a.md');
    const original = '---\nname: a\nnli_resolved: true\n---\n\nBody.\n';
    writeFileSync(note, original);
    const out = runCleanup(root);
    assert.match(out, /DRY-RUN/);
    assert.match(out, /would strip NLI frontmatter from: .*a\.md/);
    assert.equal(readFileSync(note, 'utf-8'), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('leaves a note without NLI keys untouched', () => {
  const root = setupVault();
  try {
    const note = join(root, '0-inbox', 'clean.md');
    const original = '---\nname: clean\ntags: [x]\n---\n\nBody.\n';
    writeFileSync(note, original);
    const out = runCleanup(root, ['--execute']);
    assert.doesNotMatch(out, /stripped NLI frontmatter/);
    assert.equal(readFileSync(note, 'utf-8'), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
