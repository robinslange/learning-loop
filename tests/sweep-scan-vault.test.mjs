// Tests for scanVaultCandidates() — the node replacement for the /reflect
// Step 4.4 python3 vault walk (S2 in the reflect-improvements plan).
//
// The walk computes the candidate union for the post-batch sweep:
//   (1) notes with no [[wikilink]] in the body  -> autolink/edge-infer backfill
//   (2) notes whose frontmatter reflect_sid == this session's sid
// over an explicit 5-folder ALLOWLIST. The single most important guard: it must
// NOT descend into 4-projects (free-form index notes the python deliberately
// excluded). The walk goes through vault-walk.mjs#listVaultNotes with its
// `dirs` restriction; this test pins that the restriction never drops.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { scanVaultCandidates } from '../plugin/scripts/sweep-hook-replay.mjs';

const SCRIPT = new URL('../plugin/scripts/sweep-hook-replay.mjs', import.meta.url).pathname;

function runCli(args) {
  try {
    const stdout = execFileSync('node', [SCRIPT, ...args], { encoding: 'utf-8' });
    return { status: 0, stdout };
  } catch (err) {
    return { status: err.status ?? 1, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

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

// Every allowlisted folder must be walked — not just a sampled few. A regression
// that drops 1-fleeting or 5-maps from SWEEP_FOLDERS would otherwise pass CI.
for (const folder of ['0-inbox', '1-fleeting', '2-literature', '3-permanent', '5-maps']) {
  test(`flags an unlinked-body note in the ${folder} allowlist folder`, () => {
    const root = setupVault();
    try {
      const p = join(root, folder, 'unlinked.md');
      writeFileSync(p, '---\nname: unlinked\n---\n\nNo wikilinks here.\n');
      assert.deepEqual(scanVaultCandidates(root, 'sess-1'), [p]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

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

test('flags a CRLF note whose frontmatter reflect_sid matches the session', () => {
  const root = setupVault();
  try {
    const p = join(root, '2-literature', 'crlf.md');
    // linked body (set (1) does NOT catch it); only the sid stamp selects it,
    // so an LF-only frontmatter parse silently drops the note.
    writeFileSync(
      p,
      '---\r\nname: crlf\r\nreflect_sid: sess-1\r\n---\r\n\r\nLinked [[note]] body.\r\n',
    );
    assert.deepEqual(scanVaultCandidates(root, 'sess-1'), [p]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('finds an unlinked note in a SUBFOLDER of an allowlisted folder', () => {
  const root = setupVault();
  try {
    mkdirSync(join(root, '0-inbox', 'topic'), { recursive: true });
    const p = join(root, '0-inbox', 'topic', 'nested.md');
    writeFileSync(p, '---\nname: nested\n---\n\nNo wikilinks here.\n');
    assert.deepEqual(scanVaultCandidates(root, 'sess-1'), [p]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('skips _archive subfolders inside allowlisted folders', () => {
  const root = setupVault();
  try {
    mkdirSync(join(root, '0-inbox', '_archive'), { recursive: true });
    writeFileSync(
      join(root, '0-inbox', '_archive', 'old.md'),
      '---\nname: old\n---\n\nNo wikilinks here.\n',
    );
    assert.deepEqual(scanVaultCandidates(root, 'sess-1'), []);
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

// End-to-end CLI dispatch (the path Step 4.4 actually invokes), not just the
// exported function — covers arg parsing, the replay handoff, and the guards.
test('--scan-vault CLI scans, replays, and reports a JSON summary', () => {
  const root = setupVault();
  try {
    writeFileSync(join(root, '0-inbox', 'note.md'), '---\nname: note\n---\n\nUnlinked.\n');
    const { status, stdout } = runCli(['--scan-vault', root, '--sid', 'sess-1']);
    const summary = JSON.parse(stdout);
    assert.equal(summary.processed, 1, 'the one unlinked note is processed');
    // replay runs hooks/post-tool.js per note; status is 0 (ok) or 1 (a hook
    // failed) but the candidate selection + dispatch must have run.
    assert.ok(status === 0 || status === 1, `unexpected exit ${status}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--scan-vault rejects a flag where the root should be (exit 2)', () => {
  // Guards the arg-parse hole: `--scan-vault --sid x` must NOT treat "--sid" as
  // the root and silently print {processed:0} exit 0.
  const r = runCli(['--scan-vault', '--sid', 'sess-1']);
  assert.equal(r.status, 2, 'a flag-as-root must be a usage error, not a silent empty scan');
});

test('--scan-vault with a dangling --sid is a usage error (exit 2)', () => {
  const root = setupVault();
  try {
    const r = runCli(['--scan-vault', root, '--sid']);
    assert.equal(r.status, 2, 'a --sid with no value must be a usage error');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--help lists the --scan-vault mode', () => {
  const { stdout } = runCli(['--help']);
  assert.match(stdout, /--scan-vault <root> --sid <sid>/, '--help must document --scan-vault');
});
