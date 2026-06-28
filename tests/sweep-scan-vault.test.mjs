// Tests for scanVaultCandidates() — the node replacement for the /reflect
// Step 4.4 python3 vault walk (S2 in the reflect-improvements plan).
//
// The walk computes the candidate union for the post-batch sweep:
//   (1) notes with no [[wikilink]] in the body  -> autolink/edge-infer backfill
//   (2) notes whose frontmatter reflect_sid == this session's sid
// over an explicit 5-folder ALLOWLIST. The single most important guard: it must
// NOT descend into 4-projects (free-form index notes the python deliberately
// excluded). vault-walk.mjs#listVaultNotes is a denylist that WOULD include
// 4-projects — this test pins that we don't regress to it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanVaultCandidates } from '../plugin/scripts/sweep-hook-replay.mjs';

function setupVault() {
  const root = mkdtempSync(join(tmpdir(), 'scan-vault-'));
  for (const f of [
    '0-inbox',
    '1-fleeting',
    '2-literature',
    '3-permanent',
    '5-maps',
    '4-projects',
  ]) {
    mkdirSync(join(root, f), { recursive: true });
  }
  return root;
}

test('flags an unlinked-body note in an allowlisted folder', () => {
  const root = setupVault();
  try {
    const p = join(root, '0-inbox', 'unlinked.md');
    writeFileSync(p, '---\nname: unlinked\n---\n\nNo wikilinks here.\n');
    const got = scanVaultCandidates(root, 'sess-1');
    assert.deepEqual(got, [p]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('does NOT flag a linked note that is not this session', () => {
  const root = setupVault();
  try {
    const p = join(root, '3-permanent', 'linked.md');
    writeFileSync(p, '---\nname: linked\n---\n\nHas a [[wikilink]] and no reflect_sid.\n');
    assert.deepEqual(scanVaultCandidates(root, 'sess-1'), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('flags a linked note when its frontmatter reflect_sid matches the session', () => {
  const root = setupVault();
  try {
    const p = join(root, '2-literature', 'mine.md');
    // linked body (so set (1) does NOT catch it) but stamped with our sid (set (2))
    writeFileSync(p, '---\nname: mine\nreflect_sid: sess-1\n---\n\nLinked [[note]] body.\n');
    assert.deepEqual(scanVaultCandidates(root, 'sess-1'), [p]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('does NOT flag a note stamped with a DIFFERENT session', () => {
  const root = setupVault();
  try {
    const p = join(root, '2-literature', 'other.md');
    writeFileSync(p, '---\nname: other\nreflect_sid: sess-OTHER\n---\n\nLinked [[note]] body.\n');
    assert.deepEqual(scanVaultCandidates(root, 'sess-1'), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('EXCLUDES 4-projects even when the note is unlinked (the S2 trap)', () => {
  const root = setupVault();
  try {
    // an unlinked note in 4-projects would be swept by a denylist walk; the
    // allowlist must skip it.
    writeFileSync(
      join(root, '4-projects', 'index.md'),
      '---\nname: proj\n---\n\nFree-form index, no links.\n',
    );
    // and an unlinked note in an allowlisted folder, to prove the walk ran
    const ok = join(root, '0-inbox', 'real.md');
    writeFileSync(ok, '---\nname: real\n---\n\nUnlinked.\n');
    assert.deepEqual(scanVaultCandidates(root, 'sess-1'), [ok]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('emits each matching note once even if it satisfies both sets', () => {
  const root = setupVault();
  try {
    const p = join(root, '0-inbox', 'both.md');
    // unlinked body AND our sid -> both sets, must appear once
    writeFileSync(p, '---\nname: both\nreflect_sid: sess-1\n---\n\nUnlinked.\n');
    assert.deepEqual(scanVaultCandidates(root, 'sess-1'), [p]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
