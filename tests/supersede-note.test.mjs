// tests/supersede-note.test.mjs
//
// supersede-note.mjs is the mechanical writer for the invalidated/superseded_by
// frontmatter pair capture-rules.md defines and enrichVaultHits (inject.mjs)
// honours. Both /rewrite (ARCHIVE step) and /reflect refinement's supersede
// path call it instead of hand-rolling the frontmatter edit or writing a stub
// retrieval cannot read.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stampSupersession, supersedeNoteFile } from '../plugin/scripts/supersede-note.mjs';
import { parseFrontmatter } from '../plugin/scripts/lib/markdown-parse.mjs';

describe('stampSupersession (pure frontmatter edit)', () => {
  it('adds invalidated: and superseded_by: to a note with no prior invalidation', () => {
    const raw = '---\ntags: [a]\ndate: 2026-01-01\nsource: synthesis\n---\n\nOld claim.\n';
    const { next, changed } = stampSupersession(raw, {
      date: '2026-09-22',
      replacementPath: '3-permanent/new-note.md',
    });
    assert.equal(changed, true);
    const { fm, body } = parseFrontmatter(next);
    assert.equal(fm.invalidated, '2026-09-22');
    assert.equal(fm.superseded_by, '3-permanent/new-note.md');
    assert.match(body, /Old claim\./, 'body must be untouched');
  });

  it('skips a note already carrying invalidated: (never overwrites)', () => {
    const raw =
      '---\ntags: [a]\ndate: 2026-01-01\nsource: synthesis\ninvalidated: 2026-05-01\n---\n\nOld claim.\n';
    const { next, changed } = stampSupersession(raw, {
      date: '2026-09-22',
      replacementPath: '3-permanent/new-note.md',
    });
    assert.equal(changed, false);
    assert.equal(next, raw);
  });
});

describe('supersedeNoteFile (disk write against a temp vault)', () => {
  it('stamps the old note on disk and leaves the body intact', () => {
    const vault = mkdtempSync(join(tmpdir(), 'll-supersede-'));
    try {
      const oldPath = join(vault, 'old-note.md');
      writeFileSync(
        oldPath,
        '---\ntags: [a]\ndate: 2026-01-01\nsource: synthesis\n---\n\nOld claim, still on disk.\n',
      );
      const result = supersedeNoteFile(oldPath, {
        date: '2026-09-22',
        replacementPath: 'new-note.md',
      });
      assert.equal(result.changed, true);
      const { fm, body } = parseFrontmatter(readFileSync(oldPath, 'utf-8'));
      assert.equal(fm.invalidated, '2026-09-22');
      assert.equal(fm.superseded_by, 'new-note.md');
      assert.match(body, /Old claim, still on disk\./);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });
});

describe('stampSupersession without a replacement', () => {
  it('writes invalidated: alone', () => {
    const raw = '---\ntitle: Old\n---\nbody\n';
    const { next, changed } = stampSupersession(raw, { date: '2026-09-22' });
    assert.equal(changed, true);
    assert.match(next, /^invalidated: 2026-09-22$/m);
    assert.doesNotMatch(next, /superseded_by/);
  });
});
