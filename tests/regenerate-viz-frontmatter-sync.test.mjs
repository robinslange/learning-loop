import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncNoteFrontmatter } from '../scripts/regenerate-viz.mjs';

function setupVault() {
  const root = mkdtempSync(join(tmpdir(), 'll-viz-vault-'));
  mkdirSync(join(root, '3-permanent'), { recursive: true });
  return root;
}

test('adds NLI keys when no frontmatter exists', () => {
  const root = setupVault();
  try {
    const notePath = join(root, '3-permanent', 'note-a.md');
    writeFileSync(notePath, '# Note A\n\nBody.\n');
    syncNoteFrontmatter(notePath, ['[[note-b]]', '[[note-c]]']);
    const content = readFileSync(notePath, 'utf-8');
    assert.match(content, /^---\n/);
    assert.match(content, /has-contradiction: true/);
    assert.match(content, /nli-contradicts:\s*\["\[\[note-b\]\]", "\[\[note-c\]\]"\]/);
    assert.match(content, /\n# Note A\n/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('preserves existing frontmatter keys', () => {
  const root = setupVault();
  try {
    const notePath = join(root, '3-permanent', 'note-a.md');
    writeFileSync(notePath, '---\ntags:\n  - foo\nrelated: ["[[other]]"]\n---\n\n# A\n');
    syncNoteFrontmatter(notePath, ['[[note-b]]']);
    const content = readFileSync(notePath, 'utf-8');
    assert.match(content, /tags:\n\s*-\s*foo/);
    assert.match(content, /related:\s*\["\[\[other\]\]"\]/);
    assert.match(content, /nli-contradicts:\s*\["\[\[note-b\]\]"\]/);
    assert.match(content, /has-contradiction: true/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('overwrites existing nli-contradicts (no merge)', () => {
  const root = setupVault();
  try {
    const notePath = join(root, '3-permanent', 'note-a.md');
    writeFileSync(notePath, '---\nnli-contradicts: ["[[stale]]"]\nhas-contradiction: true\n---\n\n# A\n');
    syncNoteFrontmatter(notePath, ['[[fresh]]']);
    const content = readFileSync(notePath, 'utf-8');
    assert.doesNotMatch(content, /stale/);
    assert.match(content, /nli-contradicts:\s*\["\[\[fresh\]\]"\]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('removes keys when target list is empty', () => {
  const root = setupVault();
  try {
    const notePath = join(root, '3-permanent', 'note-a.md');
    writeFileSync(notePath, '---\ntags:\n  - foo\nnli-contradicts: ["[[stale]]"]\nhas-contradiction: true\n---\n\n# A\n');
    syncNoteFrontmatter(notePath, []);
    const content = readFileSync(notePath, 'utf-8');
    assert.doesNotMatch(content, /nli-contradicts/);
    assert.doesNotMatch(content, /has-contradiction/);
    assert.match(content, /tags:\n\s*-\s*foo/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
