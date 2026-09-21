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

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  scanVaultCandidates,
  stripAbandonedStamps,
  ABANDONED_AFTER_MS,
} from '../plugin/scripts/sweep-hook-replay.mjs';
import { reflectNewNotesPath } from '../plugin/hooks/modules/reflect-track.mjs';

const SCRIPT = fileURLToPath(new URL('../plugin/scripts/sweep-hook-replay.mjs', import.meta.url));

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
      assert.deepEqual(scanVaultCandidates(root, 'sess-1').candidates, [p]);
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
    assert.deepEqual(scanVaultCandidates(root, 'sess-1').candidates, []);
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
    assert.deepEqual(scanVaultCandidates(root, 'sess-1').candidates, [p]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('does NOT flag a note stamped with a DIFFERENT session', () => {
  const root = setupVault();
  try {
    const p = join(root, '2-literature', 'other.md');
    writeFileSync(p, '---\nname: other\nreflect_sid: sess-OTHER\n---\n\nLinked [[note]] body.\n');
    assert.deepEqual(scanVaultCandidates(root, 'sess-1').candidates, []);
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
    assert.deepEqual(scanVaultCandidates(root, 'sess-1').candidates, [ok]);
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
    assert.deepEqual(scanVaultCandidates(root, 'sess-1').candidates, [p]);
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
    assert.deepEqual(scanVaultCandidates(root, 'sess-1').candidates, [p]);
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
    assert.deepEqual(scanVaultCandidates(root, 'sess-1').candidates, []);
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
    assert.deepEqual(scanVaultCandidates(root, 'sess-1').candidates, [p]);
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

// --- abandoned reflect_sid self-heal -----------------------------------------
//
// `reflect_sid` is transient: Step 4 stamps it, 4.4 reads it, 4.6.g strips it.
// A run that dies in between leaks the stamp permanently, because 4.6.g is its
// only remover. Found in the wild on seven notes from four dead sessions, two
// of them already promoted to 3-permanent.
//
// The marker file is the liveness signal, so these tests drive the REAL marker
// path (reflectNewNotesPath) rather than a stub: a stub would pass while the
// two sides resolved different directories, which is exactly the handshake bug
// the reflect-track header warns about.

// Marker files must land in a dir this suite owns, not the developer's real
// plugin-data. `reflectNewNotesPath` resolves through `resolvePluginData()`,
// which reads $CLAUDE_PLUGIN_DATA or a persisted marker, so without this
// override the suite wrote into
// ~/.claude/plugins/data/.../reflect-scratch/ — a directory nothing ever
// reaps (33 files on the machine this was found on) and which other sessions
// are using live. It also only passed here because that directory happened to
// exist: on a fresh install, where `/reflect` has never run, `writeFileSync`
// hit ENOENT and two tests ERRORED rather than asserting, one of them the
// concurrency test this suite calls the reason it is safe to ship. CI passed
// for a third reason again — plugin-data is unresolvable there, so the path
// falls back to `tmpdir()`.
//
// The sibling suite (tests/reflect-new-notes-track.test.mjs) already set
// CLAUDE_PLUGIN_DATA per-suite. Hardening that file against a machine-global
// path in the same change that introduced a new one is the joke this comment
// exists to stop repeating.
let pluginDataRoot;
let savedPluginData;

// Installed ONCE for the file, not per test. It was per test, and three of the
// tests that needed it silently never called it — including both tests that
// actually write marker files. A helper you must remember to call is a helper
// that eventually is not called; a hook cannot be forgotten.
before(() => {
  savedPluginData = process.env.CLAUDE_PLUGIN_DATA;
  pluginDataRoot = mkdtempSync(join(tmpdir(), 'sweep-scan-pd-'));
  // Child processes (`runCli` → execFileSync) inherit process.env, so the CLI
  // resolves the same override rather than the real plugin-data.
  process.env.CLAUDE_PLUGIN_DATA = pluginDataRoot;
});

after(() => {
  if (savedPluginData !== undefined) process.env.CLAUDE_PLUGIN_DATA = savedPluginData;
  else delete process.env.CLAUDE_PLUGIN_DATA;
  if (pluginDataRoot) rmSync(pluginDataRoot, { recursive: true, force: true });
  pluginDataRoot = undefined;
});

function withMarker(sid, ageMs) {
  const marker = reflectNewNotesPath(sid);
  // Create the scratch dir rather than assuming it: a fresh plugin-data has
  // no reflect-scratch/ until the first /reflect run creates one.
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, '');
  if (ageMs) {
    const when = (Date.now() - ageMs) / 1000;
    utimesSync(marker, when, when);
  }
  return () => rmSync(marker, { force: true });
}

// The suite must not touch the real plugin-data, on any machine, in any
// install state. Asserted by containment, the same way the sibling suite
// asserts its session-id file: an equality check against some known-bad
// constant would pass vacuously wherever that constant is not what resolves.
// Two assertions, because the first one passed while the suite was still
// writing into the real plugin-data: it only proved the resolver agreed with
// whatever `before` had set, and `before` was not setting it for the tests that
// write. The second states the property directly, in terms of the directory
// that must never be touched, so it holds regardless of how the override is
// plumbed.
test('keeps its marker files inside a temp plugin-data it owns', () => {
  const marker = reflectNewNotesPath('containment-check');
  assert.ok(
    marker.startsWith(pluginDataRoot),
    `marker must live under this suite's plugin-data, got ${marker} outside ${pluginDataRoot}`,
  );
  assert.ok(
    !marker.includes(join('.claude', 'plugins', 'data')),
    `marker must never resolve into the real plugin-data, got ${marker}`,
  );
});

function stamped(root, folder, name, sid) {
  const p = join(root, folder, name);
  writeFileSync(p, `---\nname: ${name}\nreflect_sid: ${sid}\n---\n\nBody [[link]].\n`);
  return p;
}

test('a stamp whose session left no marker is abandoned', () => {
  const root = setupVault();
  try {
    const p = stamped(root, '3-permanent', 'orphan.md', 'dead-sess');
    const { abandoned } = scanVaultCandidates(root, 'sess-1');
    assert.deepEqual(abandoned, [p], 'no marker means nothing is left to consume the stamp');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a stamp whose marker is older than the window is abandoned', () => {
  const root = setupVault();
  const cleanup = withMarker('dead-sess', ABANDONED_AFTER_MS + 60_000);
  try {
    const p = stamped(root, '0-inbox', 'stale.md', 'dead-sess');
    assert.deepEqual(scanVaultCandidates(root, 'sess-1').abandoned, [p]);
  } finally {
    cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

// The one that makes this safe to ship. Two /reflect runs can overlap -- Step
// 4.4 passes LL_REFLECT_SID so that they can -- and taking a live run's stamp
// before its own 4.4 reads it hides its sub-agent notes from the sweep they
// exist for.
test('a live concurrent run’s stamp is left alone', () => {
  const root = setupVault();
  const cleanup = withMarker('other-live-sess', 0);
  try {
    stamped(root, '0-inbox', 'theirs.md', 'other-live-sess');
    assert.deepEqual(
      scanVaultCandidates(root, 'sess-1').abandoned,
      [],
      'a fresh marker means that run is still going; its stamp is working state',
    );
  } finally {
    cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test('this session’s own stamp is never abandoned, marker or not', () => {
  const root = setupVault();
  try {
    stamped(root, '0-inbox', 'mine.md', 'sess-1');
    const { candidates, abandoned } = scanVaultCandidates(root, 'sess-1');
    assert.deepEqual(abandoned, [], 'stripping our own stamp would break our own 4.4');
    assert.equal(candidates.length, 1, 'and it still lands in the sweep set');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stripping removes only the frontmatter stamp', () => {
  const root = setupVault();
  try {
    const p = join(root, '0-inbox', 'body-mention.md');
    writeFileSync(
      p,
      '---\nname: body-mention\nreflect_sid: dead-sess\ntags: [x]\n---\n\n' +
        'reflect_sid: is documented here and must survive.\n',
    );
    assert.equal(stripAbandonedStamps([p]), 1);
    const after = readFileSync(p, 'utf-8');
    assert.match(after, /^reflect_sid: is documented here/m, 'the body line survives');
    assert.doesNotMatch(after.split('---')[1], /reflect_sid:/, 'the frontmatter stamp is gone');
    assert.match(after, /tags: \[x\]/, 'the rest of the frontmatter survives');
    assert.equal(stripAbandonedStamps([p]), 0, 'idempotent: a second pass writes nothing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--scan-vault reports how many abandoned stamps it healed', () => {
  const root = setupVault();
  try {
    stamped(root, '0-inbox', 'orphan.md', 'dead-sess');
    const { stdout } = runCli(['--scan-vault', root, '--sid', 'sess-1']);
    const summary = JSON.parse(stdout);
    assert.equal(summary.abandonedStripped, 1, 'the heal must be observable, not silent');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// `--sid` is optional at the CLI, so `currentSid` can arrive empty. Without a
// guard every stamp then looks foreign — including the caller's own — and only
// the marker's existence stands between a hand-invoked sweep and a live run's
// working state.
test('an empty session id abandons nothing rather than everything', () => {
  const root = setupVault();
  try {
    stamped(root, '0-inbox', 'someone.md', 'some-other-session');
    assert.deepEqual(
      scanVaultCandidates(root, '').abandoned,
      [],
      'not knowing whose run this is must mean judging nothing, not judging everything',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
