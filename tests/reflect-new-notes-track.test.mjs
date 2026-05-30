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
    process.env.CLAUDE_CODE_SESSION_ID = 'reflect-test';
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

    it('uses session-keyed path expansion consistently', () => {
      // Step 4.6 reads, Step 4.6.g deletes, the hook appends — all three
      // must hit the same path or the handshake breaks silently.
      const expected = '${TMPDIR:-/tmp}/ll-${CLAUDE_CODE_SESSION_ID:-session}-reflect';
      const occurrences = (skill.match(/\$\{TMPDIR:-\/tmp\}\/ll-\$\{CLAUDE_CODE_SESSION_ID:-[^}]+\}-reflect/g) || []);
      assert.ok(
        occurrences.length >= 3,
        `expected at least 3 references to the session-keyed reflect prefix (init, refinement, cleanup); ` +
          `found ${occurrences.length}: ${JSON.stringify(occurrences)}`,
      );
      for (const occ of occurrences) {
        assert.equal(
          occ,
          expected,
          `every reference must use the literal "session" fallback to match the hook's expansion; ` +
            `found "${occ}"`,
        );
      }
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

  // Regression (observed 2026-05-30): the PostToolUse hook subprocess does NOT
  // reliably inherit $CLAUDE_CODE_SESSION_ID, while the skill's bash (Bash tool)
  // does. The old code resolved the hook's session id from process.env only, so
  // when the env var was absent it fell back to 'session', wrote to a path the
  // skill never created, and the handshake broke silently. The harness passes
  // the real id as `session_id` in the hook stdin payload; post-tool.js threads
  // it through as ctx.sessionId. These tests pin that the payload id wins and
  // matches the path the skill's bash (env-var) side builds.
  describe('session-id resolution when the hook env var is absent', () => {
    let runReflectTrack;
    let reflectNewNotesPath;
    let savedSid;

    before(async () => {
      savedSid = process.env.CLAUDE_CODE_SESSION_ID;
      delete process.env.CLAUDE_CODE_SESSION_ID;
      const mod = await import('../hooks/modules/reflect-track.mjs?bust=noenv' + Date.now());
      runReflectTrack = mod.runReflectTrack;
      reflectNewNotesPath = mod.reflectNewNotesPath;
    });

    after(() => {
      if (savedSid !== undefined) process.env.CLAUDE_CODE_SESSION_ID = savedSid;
      else delete process.env.CLAUDE_CODE_SESSION_ID;
    });

    it('uses the payload session id over the (absent) env var', () => {
      const realSid = 'f7ad287f-2e93-473c-8c83-dd8e0380fc2c';
      // What the skill's bash builds: ${TMPDIR}/ll-${CLAUDE_CODE_SESSION_ID}-...
      const skillMarker = join(tmpRoot, `ll-${realSid}-reflect-new-notes.txt`);
      assert.equal(reflectNewNotesPath(realSid), skillMarker);
    });

    it('falls back to the literal "session" only when no id is available anywhere', () => {
      assert.equal(reflectNewNotesPath(), join(tmpRoot, 'll-session-reflect-new-notes.txt'));
    });

    it('appends to the skill-created marker when the hook only has the payload id', async () => {
      const realSid = 'f7ad287f-2e93-473c-8c83-dd8e0380fc2c';
      // The skill (which HAS the env var) creates the marker at the real-id path.
      const skillMarker = join(tmpRoot, `ll-${realSid}-reflect-new-notes.txt`);
      writeFileSync(skillMarker, '');

      // The hook fires with no env var but the harness payload's session_id.
      const fp = join(fakeVaultRoot, '0-inbox', 'real-note.md');
      await runReflectTrack({
        tool: 'Write',
        input: { file_path: fp },
        vaultRoot: fakeVaultRoot,
        sessionId: realSid,
      });

      assert.equal(
        readFileSync(skillMarker, 'utf8'),
        fp + '\n',
        'hook must append to the path the skill built from $CLAUDE_CODE_SESSION_ID, ' +
          'not to a literal-"session" path',
      );
      rmSync(skillMarker);
    });
  });
});
