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
import { spawnSync } from 'node:child_process';
import { stampSupersession, supersedeNoteFile } from '../plugin/scripts/supersede-note.mjs';
import { parseFrontmatter } from '../plugin/scripts/lib/markdown-parse.mjs';

const SCRIPT = join(import.meta.dirname, '..', 'plugin', 'scripts', 'supersede-note.mjs');

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
  it('stamps the old note on disk and leaves the body intact', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'll-supersede-'));
    try {
      const oldPath = join(vault, 'old-note.md');
      writeFileSync(
        oldPath,
        '---\ntags: [a]\ndate: 2026-01-01\nsource: synthesis\n---\n\nOld claim, still on disk.\n',
      );
      const result = await supersedeNoteFile(oldPath, {
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

describe('stampSupersession reason field (distinguishes no-frontmatter from already-invalidated)', () => {
  it('a note with no frontmatter block returns reason: no-frontmatter', () => {
    const raw = '# Plain note\n\nNo frontmatter here.\n';
    const result = stampSupersession(raw, { date: '2026-09-22' });
    assert.equal(result.changed, false);
    assert.equal(result.reason, 'no-frontmatter');
    assert.equal(result.next, raw);
  });

  it('a note already carrying invalidated: returns reason: already-invalidated', () => {
    const raw =
      '---\ntags: [a]\ndate: 2026-01-01\nsource: synthesis\ninvalidated: 2026-05-01\n---\n\nOld claim.\n';
    const result = stampSupersession(raw, { date: '2026-09-22' });
    assert.equal(result.changed, false);
    assert.equal(result.reason, 'already-invalidated');
  });

  it('a successful stamp carries no reason field', () => {
    const raw = '---\ntags: [a]\n---\n\nOld claim.\n';
    const result = stampSupersession(raw, { date: '2026-09-22' });
    assert.equal(result.changed, true);
    assert.equal(result.reason, undefined);
  });
});

describe('stampSupersession preserves CRLF line endings', () => {
  it('a CRLF note produces output with no bare \\n', () => {
    const raw = '---\r\ntags: [a]\r\ndate: 2026-01-01\r\n---\r\n\r\nOld claim.\r\n';
    const { next, changed } = stampSupersession(raw, {
      date: '2026-09-22',
      replacementPath: '3-permanent/new-note.md',
    });
    assert.equal(changed, true);
    // No bare \n: every \n in the output must be preceded by \r.
    assert.doesNotMatch(next, /(?<!\r)\n/);
    const { fm } = parseFrontmatter(next);
    assert.equal(fm.invalidated, '2026-09-22');
    assert.equal(fm.superseded_by, '3-permanent/new-note.md');
  });
});

describe('stampSupersession replaces an existing superseded_by: instead of appending a second one', () => {
  it('a note with superseded_by: but no invalidated: gets one superseded_by: line, the new pointer', () => {
    const raw =
      '---\ntags: [a]\ndate: 2026-01-01\nsource: synthesis\nsuperseded_by: 3-permanent/old-replacement.md\n---\n\nOld claim.\n';
    const { next, changed } = stampSupersession(raw, {
      date: '2026-09-22',
      replacementPath: '3-permanent/new-replacement.md',
    });
    assert.equal(changed, true);
    const { fm } = parseFrontmatter(next);
    assert.equal(fm.invalidated, '2026-09-22');
    assert.equal(fm.superseded_by, '3-permanent/new-replacement.md');
    const supersededByLines = next.split('\n').filter((l) => l.startsWith('superseded_by:'));
    assert.equal(
      supersededByLines.length,
      1,
      `expected exactly one superseded_by: line; got ${JSON.stringify(supersededByLines)}`,
    );
  });

  it('a block-list superseded_by: goes with its items, leaving no orphan under the key above', () => {
    const raw = '---\ntags: [a]\nsuperseded_by:\n  - 3-permanent/a.md\n- 3-permanent/b.md\n---\nBody.\n';
    const { next } = stampSupersession(raw, {
      date: '2026-09-22',
      replacementPath: '3-permanent/new.md',
    });
    assert.equal(
      next,
      '---\ntags: [a]\ninvalidated: 2026-09-22\nsuperseded_by: 3-permanent/new.md\n---\nBody.\n',
    );
  });
});

describe('stampSupersession keeps the rest of the frontmatter as written', () => {
  it('a blank line inside a | block survives', () => {
    const raw = '---\ndescription: |\n  one\n\n  two\ntags: [a]\n---\nBody.\n';
    const { next } = stampSupersession(raw, { date: '2026-09-22' });
    assert.equal(
      next,
      '---\ndescription: |\n  one\n\n  two\ntags: [a]\ninvalidated: 2026-09-22\n---\nBody.\n',
    );
  });

  it('an empty invalidated: is replaced, not duplicated', () => {
    const raw = '---\ntags: [a]\ninvalidated:\n---\nBody.\n';
    const { next, changed } = stampSupersession(raw, { date: '2026-09-22' });
    assert.equal(changed, true);
    assert.equal(next, '---\ntags: [a]\ninvalidated: 2026-09-22\n---\nBody.\n');
  });
});

describe('supersede-note.mjs CLI: exit code and JSON per reason', () => {
  it('no-frontmatter: exits 1 and reports ok:false', () => {
    const vault = mkdtempSync(join(tmpdir(), 'll-supersede-cli-'));
    try {
      const notePath = join(vault, 'no-frontmatter.md');
      writeFileSync(notePath, '# Plain note\n\nNo frontmatter here.\n');
      const r = spawnSync(process.execPath, [SCRIPT, notePath], { encoding: 'utf-8' });
      assert.equal(r.status, 1, `expected exit 1; stdout: ${r.stdout} stderr: ${r.stderr}`);
      const out = JSON.parse(r.stdout.trim());
      assert.deepEqual(out, { ok: false, stamped: false, reason: 'no-frontmatter' });
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  it('already-invalidated: exits 0 and reports ok:true, stamped:false', () => {
    const vault = mkdtempSync(join(tmpdir(), 'll-supersede-cli-'));
    try {
      const notePath = join(vault, 'already-invalidated.md');
      writeFileSync(notePath, '---\ntags: [a]\ninvalidated: 2026-05-01\n---\n\nOld claim.\n');
      const r = spawnSync(process.execPath, [SCRIPT, notePath], { encoding: 'utf-8' });
      assert.equal(r.status, 0, `expected exit 0; stdout: ${r.stdout} stderr: ${r.stderr}`);
      const out = JSON.parse(r.stdout.trim());
      assert.deepEqual(out, { ok: true, stamped: false, reason: 'already-invalidated' });
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });
});

describe('supersedeNoteFile archives outgoing edges best-effort', () => {
  it('a successful stamp with no edges db present still stamps, with edges_archived: 0', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'll-supersede-edges-'));
    const pluginData = mkdtempSync(join(tmpdir(), 'll-supersede-edges-pd-'));
    try {
      const oldPath = join(vault, 'old-note.md');
      writeFileSync(oldPath, '---\ntags: [a]\n---\n\nOld claim.\n');
      const result = await supersedeNoteFile(oldPath, {
        date: '2026-09-22',
        replacementPath: 'new-note.md',
        vaultPath: vault,
        pluginData,
      });
      assert.equal(result.changed, true);
      assert.equal(result.edgesArchived, 0, 'no edges db exists, so nothing was archived');
    } finally {
      rmSync(vault, { recursive: true, force: true });
      rmSync(pluginData, { recursive: true, force: true });
    }
  });

  it("a successful stamp with an edges db archives the note's outgoing edges", async () => {
    const { openEdgeDb, addEdge, saveDb } = await import('../plugin/scripts/lib/edges.mjs');
    const vault = mkdtempSync(join(tmpdir(), 'll-supersede-edges-'));
    const pluginData = mkdtempSync(join(tmpdir(), 'll-supersede-edges-pd-'));
    try {
      const oldPath = join(vault, 'old-note.md');
      writeFileSync(oldPath, '---\ntags: [a]\n---\n\nOld claim.\n');

      const dbPath = join(pluginData, 'edges.db');
      const db = await openEdgeDb(dbPath);
      addEdge(db, { fromPath: 'old-note.md', toPath: 'other.md', edgeType: 'supports' });
      saveDb(db, dbPath);
      db.close();

      const result = await supersedeNoteFile(oldPath, {
        date: '2026-09-22',
        replacementPath: 'new-note.md',
        vaultPath: vault,
        pluginData,
      });
      assert.equal(result.changed, true);
      assert.equal(result.edgesArchived, 1);

      const { getEdgesFrom } = await import('../plugin/scripts/lib/edges.mjs');
      const reopened = await openEdgeDb(dbPath);
      const rows = getEdgesFrom(reopened, 'old-note.md');
      reopened.close();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].source_graph, 'archived');
    } finally {
      rmSync(vault, { recursive: true, force: true });
      rmSync(pluginData, { recursive: true, force: true });
    }
  });

  it('a skip (already-invalidated) never touches edges: edgesArchived is undefined', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'll-supersede-edges-'));
    const pluginData = mkdtempSync(join(tmpdir(), 'll-supersede-edges-pd-'));
    try {
      const oldPath = join(vault, 'old-note.md');
      writeFileSync(oldPath, '---\ntags: [a]\ninvalidated: 2026-05-01\n---\n\nOld claim.\n');
      const result = await supersedeNoteFile(oldPath, {
        date: '2026-09-22',
        vaultPath: vault,
        pluginData,
      });
      assert.equal(result.changed, false);
      assert.equal(result.edgesArchived, undefined);
    } finally {
      rmSync(vault, { recursive: true, force: true });
      rmSync(pluginData, { recursive: true, force: true });
    }
  });
});
