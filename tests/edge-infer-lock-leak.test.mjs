// Regression test for the edge-infer lock-leak fix (#8).
//
// runEdgeInfer acquires an advisory lock on edges.db BEFORE opening the db. The
// pre-fix code opened the db above the try/finally, so a throw from openEdgeDb
// skipped releaseLock and wedged the lock permanently — every later run then
// short-circuits at the acquireLock guard and silently drops edge work. The fix
// moves openEdgeDb inside the try (db=null init) so the finally always releases.
//
// We force openEdgeDb to throw at the real filesystem boundary: edges.db is
// created as a DIRECTORY, so openEdgeDb's readFileSync(dbPath) throws EISDIR
// after the lock is held. The test asserts the lock is released regardless.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runEdgeInfer } from '../plugin/hooks/modules/edge-infer.mjs';
import { acquireLock, releaseLock } from '../plugin/scripts/lib/edges.mjs';

const VAULT = fileURLToPath(new URL('./fixtures/vault-small', import.meta.url));
const NOTE_REL = '0-inbox/rebuttal-note.md';
const NOTE_ABS = join(VAULT, NOTE_REL);

function buildMinimalSnapshot(vaultRoot) {
  const notes = [
    { folder: '3-permanent', basename: 'sleep', rel_path: '3-permanent/sleep.md' },
    { folder: '0-inbox', basename: 'rebuttal-note', rel_path: NOTE_REL },
  ];
  return {
    version: 1,
    vault_root: vaultRoot,
    built_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30_000).toISOString(),
    notes,
    relPathSet: new Set(notes.map((n) => n.rel_path)),
  };
}

test('runEdgeInfer releases the edges.db lock when openEdgeDb throws', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-edge-infer-leak-'));
  const savedPluginData = process.env.CLAUDE_PLUGIN_DATA;
  const dbPath = join(dir, 'edges.db');
  const lockPath = `${dbPath}.lock`;

  try {
    process.env.CLAUDE_PLUGIN_DATA = dir;

    // Make openEdgeDb(dbPath) throw: a directory named edges.db makes its
    // readFileSync(dbPath) fail with EISDIR, inside runEdgeInfer's try block.
    mkdirSync(dbPath, { recursive: true });

    const ctx = {
      tool: 'Write',
      input: {
        // Content with a classifying wikilink so edges.length > 0 and control
        // reaches acquireLock + openEdgeDb (past the edges.length === 0 return).
        file_path: NOTE_ABS,
        content: '---\ntags: [test]\n---\n\nThis proves [[sleep]] drives recovery.\n',
      },
      response: { success: true },
      vaultRoot: VAULT,
      snapshot: buildMinimalSnapshot(VAULT),
    };

    // The open failure may surface as a thrown error; either way the lock must
    // be released. Swallow the throw so we can assert on lock state.
    await runEdgeInfer(ctx).catch(() => {});

    // The leak is observable two ways: the on-disk lockfile must be gone, and
    // the module-scoped single-holder state must be free (a fresh acquire wins).
    assert.equal(existsSync(lockPath), false, 'edges.db.lock must not be left behind');

    // Point the lock at a clean sibling path (edges.db here is a directory).
    const probePath = join(dir, 'probe.db');
    assert.equal(
      acquireLock(probePath),
      true,
      'lock holder state was released, so a fresh acquire succeeds',
    );
    releaseLock(probePath);
  } finally {
    if (savedPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = savedPluginData;
    rmSync(dir, { recursive: true, force: true });
  }
});
