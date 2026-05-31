// Regression test for the /reflect Step 4 new-notes tracking handshake.
//
// Failure mode (observed 2026-05-24): /reflect Step 4 used to instruct the
// agent to append one path per vault Write to a session-keyed temp file.
// Step 4.6 read that file to build refinement pairs. In a real session,
// after 4 vault Writes only the last path survived — Step 4.6 then saw 1
// candidate instead of 4.
//
// Root cause: Step 4's bash code fence bundled `: > "$FILE"` (truncate) and
// `echo "$PATH" >> "$FILE"` (append) into one block, separated only by an
// inline `# After each vault Write:` comment. An agent re-running the block
// per Write re-truncated each time.
//
// Fix: ownership of the per-write append moved into the post-tool hook
// (hooks/modules/reflect-track.mjs). Step 4 now only creates an empty
// marker file once; the hook appends every vault Write/Edit path until
// Step 4.6.g removes the marker.
//
// This test pins the new contract:
//   - SKILL.md has a single, identifiable "Step 4 init" fence and no
//     "per-write append" fence (the bundled-fence footgun cannot recur if
//     the bundle no longer exists in the SKILL at all).
//   - The hook's append path matches the SKILL's path expansion exactly,
//     so the handshake doesn't drift.
//   - Running the hook module N times against the marker preserves N
//     entries (smoke test for the append-not-truncate behaviour).

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = join(__dirname, '..', 'skills', 'reflect', 'SKILL.md');

// Extract the ```bash fence containing the given marker substring on any
// line inside its body. Returns the block contents without the fences.
function extractFence(skillText, markerSubstring) {
  const lines = skillText.split('\n');
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === '```bash') {
      const start = i + 1;
      let end = start;
      while (end < lines.length && lines[end].trim() !== '```') end++;
      const body = lines.slice(start, end).join('\n');
      if (body.includes(markerSubstring)) {
        return { body, startLine: start + 1 };
      }
      i = end + 1;
    } else {
      i++;
    }
  }
  return null;
}

describe('/reflect Step 4 new-notes tracking handshake', () => {
  let skill;
  let tmpRoot;
  let savedTmpdir;
  let savedSessionId;
  let savedVault;
  let fakeVaultRoot;

  before(() => {
    skill = readFileSync(SKILL_PATH, 'utf8');
    tmpRoot = mkdtempSync(join(tmpdir(), 'll-reflect-newnotes-test-'));
    fakeVaultRoot = mkdtempSync(join(tmpdir(), 'll-reflect-newnotes-vault-'));

    savedTmpdir = process.env.TMPDIR;
    savedSessionId = process.env.CLAUDE_CODE_SESSION_ID;
    savedVault = process.env.LL_VAULT_PATH;
    process.env.TMPDIR = tmpRoot;
    // Both sides of the handshake key the marker on the plugin's own session id,
    // written once at SessionStart to the unsuffixed learning-loop-session-id
    // file. Seed it the way session-start would so reflectNewNotesPath() and the
    // skill's bash `cat` resolve the same id. The env var is deliberately left
    // unset for most tests — it must NOT influence the path anymore.
    writeFileSync(join(tmpRoot, 'learning-loop-session-id'), 'reflect-test');
    delete process.env.CLAUDE_CODE_SESSION_ID;
  });

  after(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    rmSync(fakeVaultRoot, { recursive: true, force: true });
    if (savedTmpdir !== undefined) process.env.TMPDIR = savedTmpdir;
    else delete process.env.TMPDIR;
    if (savedSessionId !== undefined) process.env.CLAUDE_CODE_SESSION_ID = savedSessionId;
    else delete process.env.CLAUDE_CODE_SESSION_ID;
    if (savedVault !== undefined) process.env.LL_VAULT_PATH = savedVault;
    else delete process.env.LL_VAULT_PATH;
  });

  describe('SKILL.md contract', () => {
    it('keeps the "Step 4 init: truncate the new-notes file" fence', () => {
      const initBlock = extractFence(skill, 'Step 4 init: truncate the new-notes file');
      assert.ok(
        initBlock,
        'Could not find the bash fence marked "Step 4 init: truncate the new-notes file". ' +
          'The init marker fence is the entire handshake the post-tool hook keys off — ' +
          'losing the marker text means the hook lookup drifted.',
      );
      // Sanity: the init block contains a truncate against the new-notes file.
      assert.match(
        initBlock.body,
        /:\s*>\s*"\$\{LL_TMP_PREFIX\}-new-notes\.txt"/,
        'init block should truncate the new-notes file via `: > "${LL_TMP_PREFIX}-new-notes.txt"`',
      );
    });

    it('does NOT contain a per-write echo append fence', () => {
      // The original bug was a per-write `echo "$PATH" >> "${LL_TMP_PREFIX}-new-notes.txt"`
      // bundled into the same fence as the init. Ownership is now the hook's,
      // not the skill's. If a future edit reintroduces a per-write echo fence,
      // the bundled-fence regression becomes possible again.
      assert.doesNotMatch(
        skill,
        /echo\s+["'][^"']*["']\s+>>\s+"\$\{LL_TMP_PREFIX\}-new-notes\.txt"/,
        'SKILL.md must not contain a per-write echo append to the new-notes file. ' +
          'Tracking is the hook\'s job (hooks/modules/reflect-track.mjs).',
      );
    });

    it('uses file-keyed path expansion consistently', () => {
      // Step 4.6 reads, Step 4.6.g deletes, the hook appends — all three must
      // hit the same path or the handshake breaks silently. The session id is
      // read from the shared learning-loop-session-id file (NOT the harness env
      // var, which is a different id system), so every reflect-prefix reference
      // must expand from ${LL_SID:-session}, never ${CLAUDE_CODE_SESSION_ID:-...}.
      const expected = '${TMPDIR:-/tmp}/ll-${LL_SID:-session}-reflect';
      const occurrences = (skill.match(/\$\{TMPDIR:-\/tmp\}\/ll-\$\{[A-Z_]+:-[^}]+\}-reflect/g) || []);
      assert.ok(
        occurrences.length >= 3,
        `expected at least 3 references to the session-keyed reflect prefix (init, refinement, cleanup); ` +
          `found ${occurrences.length}: ${JSON.stringify(occurrences)}`,
      );
      for (const occ of occurrences) {
        assert.equal(
          occ,
          expected,
          `every reference must read the session id from the shared file via LL_SID, ` +
            `not the harness env var; found "${occ}"`,
        );
      }
    });

    it('resolves LL_SID from the learning-loop-session-id file wherever the prefix is built', () => {
      // Each bash block that builds a reflect path must first read LL_SID from
      // the plugin's session-id file — that is the source the hook also reads.
      // Pin the exact snippet so a future edit can't quietly drop it and
      // re-split the two sides of the handshake.
      const snippet =
        'LL_SID=$(cat "${TMPDIR:-/tmp}/learning-loop-session-id" 2>/dev/null || echo session)';
      const snippetCount = skill.split(snippet).length - 1;
      assert.ok(
        snippetCount >= 4,
        `expected the LL_SID resolution snippet in every reflect/sweep bash block ` +
          `(init, sweep, 4.6.a, 4.6.c, 4.6.g); found ${snippetCount}`,
      );
      // And the env var must not survive in any operative expansion.
      assert.doesNotMatch(
        skill,
        /\$\{TMPDIR:-\/tmp\}\/ll-\$\{CLAUDE_CODE_SESSION_ID/,
        'no reflect path may key off $CLAUDE_CODE_SESSION_ID — it diverges from the hook',
      );
    });
  });

  describe('hook handshake (hooks/modules/reflect-track.mjs)', () => {
    let runReflectTrack;
    let reflectNewNotesPath;

    before(async () => {
      // Fresh import so the module re-reads env at call time.
      const mod = await import('../hooks/modules/reflect-track.mjs?bust=' + Date.now());
      runReflectTrack = mod.runReflectTrack;
      reflectNewNotesPath = mod.reflectNewNotesPath;
    });

    beforeEach(() => {
      const marker = reflectNewNotesPath();
      if (existsSync(marker)) rmSync(marker);
    });

    it('computes the same path the SKILL writes to', () => {
      const expected = join(tmpRoot, 'll-reflect-test-reflect-new-notes.txt');
      assert.equal(reflectNewNotesPath(), expected);
    });

    it('no-ops when the marker file does not exist', async () => {
      // Outside a /reflect Step 4 window, vault Writes must not leak into
      // the new-notes file. The marker absent is the whole signal.
      const marker = reflectNewNotesPath();
      assert.equal(existsSync(marker), false);

      await runReflectTrack({
        tool: 'Write',
        input: { file_path: join(fakeVaultRoot, '0-inbox', 'a.md') },
        vaultRoot: fakeVaultRoot,
      });

      assert.equal(existsSync(marker), false, 'no marker → no file created');
    });

    it('appends one line per vault Write while the marker exists', async () => {
      const marker = reflectNewNotesPath();
      writeFileSync(marker, '');

      const writes = [
        join(fakeVaultRoot, '0-inbox', 'note-1.md'),
        join(fakeVaultRoot, '0-inbox', 'note-2.md'),
        join(fakeVaultRoot, '0-inbox', 'note-3.md'),
        join(fakeVaultRoot, '0-inbox', 'note-4.md'),
      ];
      for (const fp of writes) {
        await runReflectTrack({ tool: 'Write', input: { file_path: fp }, vaultRoot: fakeVaultRoot });
      }

      const lines = readFileSync(marker, 'utf8').trimEnd().split('\n');
      assert.equal(lines.length, writes.length, `expected ${writes.length} lines, got ${lines.length}`);
      for (let i = 0; i < writes.length; i++) assert.equal(lines[i], writes[i]);
    });

    it('handles Edit the same as Write', async () => {
      const marker = reflectNewNotesPath();
      writeFileSync(marker, '');

      await runReflectTrack({
        tool: 'Edit',
        input: { file_path: join(fakeVaultRoot, '0-inbox', 'edited.md') },
        vaultRoot: fakeVaultRoot,
      });

      const lines = readFileSync(marker, 'utf8').trimEnd().split('\n');
      assert.equal(lines.length, 1);
      assert.equal(lines[0], join(fakeVaultRoot, '0-inbox', 'edited.md'));
    });

    it('ignores non-vault paths even when marker exists', async () => {
      const marker = reflectNewNotesPath();
      writeFileSync(marker, '');

      await runReflectTrack({
        tool: 'Write',
        input: { file_path: '/etc/somewhere/else.md' },
        vaultRoot: fakeVaultRoot,
      });

      assert.equal(readFileSync(marker, 'utf8'), '', 'non-vault Writes must not leak in');
    });

    it('ignores tools other than Write/Edit', async () => {
      const marker = reflectNewNotesPath();
      writeFileSync(marker, '');

      await runReflectTrack({
        tool: 'Read',
        input: { file_path: join(fakeVaultRoot, '0-inbox', 'read.md') },
        vaultRoot: fakeVaultRoot,
      });
      await runReflectTrack({
        tool: 'Bash',
        input: { command: 'echo hi' },
        vaultRoot: fakeVaultRoot,
      });

      assert.equal(readFileSync(marker, 'utf8'), '');
    });

    it('no-ops cleanly when vaultRoot is missing', async () => {
      // Vault-less sessions still run the post-tool hook (Agent/Skill events).
      // The module must not throw when called without a vault.
      const marker = reflectNewNotesPath();
      writeFileSync(marker, '');

      await runReflectTrack({
        tool: 'Write',
        input: { file_path: join(fakeVaultRoot, '0-inbox', 'x.md') },
        vaultRoot: null,
      });

      assert.equal(readFileSync(marker, 'utf8'), '');
    });
  });

  // Regression (root-caused 2026-05-30): the marker handshake straddled two
  // different id systems. The skill's bash keyed the path on the harness
  // $CLAUDE_CODE_SESSION_ID (a UUID), the hook keyed it on the stdin payload's
  // session_id, and the plugin's OWN session id (written to
  // learning-loop-session-id at SessionStart) was a third, short-hex value. The
  // env var also isn't reliably present in the hook subprocess. When any two
  // disagreed the hook wrote one path and the skill read another → empty marker,
  // refinement step silently skipped, no error. Fix: both sides read the plugin's
  // own learning-loop-session-id file. These tests pin that the file is the
  // source, the env var is ignored, an explicit arg still overrides, and the
  // 'session' last resort only fires when the file is absent.
  describe('session-id resolution from the shared learning-loop-session-id file', () => {
    let runReflectTrack;
    let reflectNewNotesPath;
    let savedSid;
    let sidFile;

    before(async () => {
      // tmpRoot is only set in the outer before(), so resolve the path here.
      sidFile = join(tmpRoot, 'learning-loop-session-id');
      // Pin a distinct env-var value so any test that wrongly reads it fails loudly.
      savedSid = process.env.CLAUDE_CODE_SESSION_ID;
      process.env.CLAUDE_CODE_SESSION_ID = 'env-var-must-be-ignored';
      const mod = await import('../hooks/modules/reflect-track.mjs?bust=file' + Date.now());
      runReflectTrack = mod.runReflectTrack;
      reflectNewNotesPath = mod.reflectNewNotesPath;
      // Restore the file the outer suite seeded (a sub-test below removes it).
      writeFileSync(sidFile, 'reflect-test');
    });

    after(() => {
      if (savedSid !== undefined) process.env.CLAUDE_CODE_SESSION_ID = savedSid;
      else delete process.env.CLAUDE_CODE_SESSION_ID;
      writeFileSync(sidFile, 'reflect-test');
    });

    it('reads the id from the file, never from $CLAUDE_CODE_SESSION_ID', () => {
      writeFileSync(sidFile, 'file-sid-abc123');
      const expected = join(tmpRoot, 'll-file-sid-abc123-reflect-new-notes.txt');
      assert.equal(reflectNewNotesPath(), expected);
    });

    it('honors an explicit sessionId argument over the file', () => {
      writeFileSync(sidFile, 'file-sid-abc123');
      const realSid = 'f7ad287f-2e93-473c-8c83-dd8e0380fc2c';
      assert.equal(
        reflectNewNotesPath(realSid),
        join(tmpRoot, `ll-${realSid}-reflect-new-notes.txt`),
      );
    });

    it('falls back to the literal "session" only when the file is absent', () => {
      rmSync(sidFile, { force: true });
      assert.equal(reflectNewNotesPath(), join(tmpRoot, 'll-session-reflect-new-notes.txt'));
    });

    it('appends to the skill-created marker when both sides read the same file', async () => {
      // Mirror production: post-tool.js passes sessionId:null, so the hook
      // resolves the path purely from the file the skill's bash also read.
      writeFileSync(sidFile, 'shared-sid-xyz');
      const skillMarker = join(tmpRoot, 'll-shared-sid-xyz-reflect-new-notes.txt');
      writeFileSync(skillMarker, '');

      const fp = join(fakeVaultRoot, '0-inbox', 'real-note.md');
      await runReflectTrack({
        tool: 'Write',
        input: { file_path: fp },
        vaultRoot: fakeVaultRoot,
        sessionId: null,
      });

      assert.equal(
        readFileSync(skillMarker, 'utf8'),
        fp + '\n',
        'hook must append to the path the skill built from the shared session-id file',
      );
      rmSync(skillMarker);
    });
  });
});
