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
// Second failure mode (root-caused 2026-06-01): even after ownership moved to
// the hook, the marker handshake still broke silently because BOTH the marker
// dir AND the session-id key were resolved through os.tmpdir(), which honors
// $TMPDIR. A hook subprocess (writer) doesn't inherit the interactive shell's
// $TMPDIR but the skill's bash (reader) does, so the two resolved different dirs
// — and getSessionId() itself returned different ids (or 'unknown') across the
// boundary. Either divergence → empty marker, refinement silently skipped, no
// error. Fix: anchor the marker dir in plugin-data (DATA_PATHS.reflectScratch)
// and make getSessionId() prefer an env-independent plugin-data/session id over
// the tmp files. plugin-data doesn't depend on $TMPDIR, so both sides meet.
//
// This test pins both contracts:
//   - SKILL.md has a single, identifiable "Step 4 init" fence and no
//     "per-write append" fence (the bundled-fence footgun cannot recur if
//     the bundle no longer exists in the SKILL at all).
//   - The hook's append path matches the SKILL's path expansion exactly,
//     so the handshake doesn't drift.
//   - The resolved path is env-INdependent: changing or unsetting $TMPDIR
//     does not move it (the two-process-split regression).
//   - A real cross-process spawn with a divergent $TMPDIR still agrees.
//   - Running the hook module N times against the marker preserves N
//     entries (smoke test for the append-not-truncate behaviour).

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = join(__dirname, '..', 'plugin', 'skills', 'reflect', 'SKILL.md');
// Step 4.6's bash blocks live in the extracted step file; the handshake
// contract (canonical resolvers, no tmp anchors) covers both files.
const REFINEMENT_STEP_PATH = join(
  __dirname,
  '..',
  'plugin',
  'skills',
  'reflect',
  'steps',
  'refinement.md',
);

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

// Extract every ```bash fence body (with its start line) from a markdown file.
function extractAllFences(text) {
  const lines = text.split('\n');
  const fences = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === '```bash') {
      const start = i + 1;
      let end = start;
      while (end < lines.length && lines[end].trim() !== '```') end++;
      fences.push({ body: lines.slice(start, end).join('\n'), startLine: start + 1 });
      i = end + 1;
    } else {
      i++;
    }
  }
  return fences;
}

describe('/reflect Step 4 new-notes tracking handshake', () => {
  let skill;
  let tmpRoot;
  let pluginData;
  let scratchDir;
  let savedTmpdir;
  let savedSessionId;
  let savedPluginData;
  let savedVault;
  let savedSessionTmpDir;
  let fakeVaultRoot;
  // The marker DIR is plugin-data/reflect-scratch (env-independent across the
  // hook/shell process boundary), set via CLAUDE_PLUGIN_DATA. The session id
  // keys the file within it via getSessionId(). With $CLAUDE_CODE_SESSION_ID
  // cleared (in before()), these outer tests drive the tmp fallback (plugin-data
  // has no session/ subdir), so seed the unsuffixed tmp id file. getSessionId()
  // reads tmpdir() at CALL time, so the path must be computed AFTER we override
  // $TMPDIR — otherwise we'd seed one dir and the resolver would read another.
  const SID = 'reflect-test';
  let sidFileBare;
  let savedSidBare;

  before(() => {
    skill = readFileSync(SKILL_PATH, 'utf8') + '\n' + readFileSync(REFINEMENT_STEP_PATH, 'utf8');
    tmpRoot = mkdtempSync(join(tmpdir(), 'll-reflect-newnotes-test-'));
    fakeVaultRoot = mkdtempSync(join(tmpdir(), 'll-reflect-newnotes-vault-'));
    pluginData = mkdtempSync(join(tmpdir(), 'll-reflect-newnotes-pd-'));
    scratchDir = join(pluginData, 'reflect-scratch');
    mkdirSync(scratchDir, { recursive: true });

    savedTmpdir = process.env.TMPDIR;
    savedSessionId = process.env.CLAUDE_CODE_SESSION_ID;
    savedPluginData = process.env.CLAUDE_PLUGIN_DATA;
    savedVault = process.env.LL_VAULT_PATH;
    savedSessionTmpDir = process.env.LL_SESSION_TMP_DIR;
    // Point $TMPDIR at a fixed test root so getSessionId() reads the id file we
    // seed below, AND so the regression tests can prove the marker path does NOT
    // follow $TMPDIR (production's bug: os.tmpdir() honored the reader's
    // /tmp/claude-501 while the hook subprocess saw /tmp). The plugin-data
    // anchor must be immune to it.
    process.env.TMPDIR = tmpRoot;
    process.env.CLAUDE_PLUGIN_DATA = pluginData;
    delete process.env.CLAUDE_CODE_SESSION_ID;
    // Clear LL_SESSION_TMP_DIR so getSessionId()'s tmp candidate resolves via
    // the $TMPDIR=tmpRoot we set above — not a developer's exported dir.
    delete process.env.LL_SESSION_TMP_DIR;

    // Seed getSessionId()'s tmp fallback at the tmpdir it resolves NOW ($TMPDIR=tmpRoot).
    sidFileBare = join(tmpdir(), 'learning-loop-session-id');
    savedSidBare = existsSync(sidFileBare) ? readFileSync(sidFileBare, 'utf8') : null;
    writeFileSync(sidFileBare, SID);
  });

  after(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    rmSync(fakeVaultRoot, { recursive: true, force: true });
    rmSync(pluginData, { recursive: true, force: true });
    if (savedTmpdir !== undefined) process.env.TMPDIR = savedTmpdir;
    else delete process.env.TMPDIR;
    if (savedSessionId !== undefined) process.env.CLAUDE_CODE_SESSION_ID = savedSessionId;
    else delete process.env.CLAUDE_CODE_SESSION_ID;
    if (savedPluginData !== undefined) process.env.CLAUDE_PLUGIN_DATA = savedPluginData;
    else delete process.env.CLAUDE_PLUGIN_DATA;
    if (savedVault !== undefined) process.env.LL_VAULT_PATH = savedVault;
    else delete process.env.LL_VAULT_PATH;
    if (savedSessionTmpDir !== undefined) process.env.LL_SESSION_TMP_DIR = savedSessionTmpDir;
    else delete process.env.LL_SESSION_TMP_DIR;
    if (savedSidBare !== null) writeFileSync(sidFileBare, savedSidBare);
    else rmSync(sidFileBare, { force: true });
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
          "Tracking is the hook's job (hooks/modules/reflect-track.mjs).",
      );
    });

    it('builds every reflect prefix under the plugin-data scratch dir, never tmp', () => {
      // Step 4.6 reads, Step 4.6.g deletes, the hook appends — all three must
      // hit the same path or the handshake breaks silently. The marker dir must
      // be plugin-data/reflect-scratch (resolved via REFLECT_SCRATCH), which is
      // env-independent across the hook/shell boundary. It must NOT live under a
      // tmp dir: os.tmpdir() honors $TMPDIR, which hook subprocesses don't
      // inherit, so a tmp anchor diverges (seen live: /tmp vs /tmp/claude-501).
      assert.doesNotMatch(
        skill,
        /\$\{TMPDIR:-\/tmp\}/,
        'no reflect/sweep path may expand from ${TMPDIR:-/tmp} — it diverges from the hook.',
      );
      assert.doesNotMatch(
        skill,
        /LL_TMP="\$\(node -e 'process\.stdout\.write\(require\("os"\)\.tmpdir/,
        'the reflect marker dir must come from REFLECT_SCRATCH (plugin-data), not os.tmpdir()',
      );
    });

    it('every fence referencing the reflect scratch prefix resolves its own paths via --sh', () => {
      // Per-fence, not aggregate: bash fences run in separate shells, so each
      // fence that builds the reflect scratch prefix must resolve its own paths
      // — a hardcoded or inherited session id / scratch dir re-splits the
      // hook/shell handshake for exactly the steps that fence drives. The
      // canonical resolver is one `eval "$(resolve-paths.mjs --sh)"` per fence,
      // which exports SESSION_ID + REFLECT_SCRATCH (among others) from a single
      // spawn; the prefix is then built from those.
      const PREFIX = '${REFLECT_SCRATCH}/ll-${SESSION_ID}-reflect';
      const SH_RESOLVER = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/resolve-paths.mjs" --sh';
      let found = 0;
      for (const { file, path } of [
        { file: 'SKILL.md', path: SKILL_PATH },
        { file: 'steps/refinement.md', path: REFINEMENT_STEP_PATH },
      ]) {
        for (const fence of extractAllFences(readFileSync(path, 'utf8'))) {
          if (!fence.body.includes(PREFIX)) continue;
          found++;
          assert.ok(
            fence.body.includes(SH_RESOLVER),
            `${file}: the bash fence starting at line ${fence.startLine} references the ` +
              `reflect scratch prefix but does not resolve its paths via the canonical ` +
              `resolve-paths.mjs --sh snippet — a hardcoded or inherited SESSION_ID/` +
              `REFLECT_SCRATCH re-splits the handshake for that fence.`,
          );
        }
      }
      assert.ok(
        found >= 3,
        `expected at least 3 bash fences referencing the reflect scratch prefix ` +
          `(4.6.a, 4.6.c, 4.6.g); found ${found}`,
      );
    });

    it('runs the Step 4.4 sweep replay with LL_REFLECT_SID set to SESSION_ID', () => {
      // The subagent-backfill fix: the replay must carry the calling session's
      // id so reflect-track appends to THIS marker (concurrency-safe). If a
      // future edit drops the env var, sub-agent notes silently stop reaching
      // the marker again and Step 4.6 refinement goes quiet.
      assert.match(
        skill,
        /LL_REFLECT_SID="\$SESSION_ID"\s+node\s+"\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/sweep-hook-replay\.mjs"/,
        'Step 4.4 must invoke sweep-hook-replay.mjs with LL_REFLECT_SID="$SESSION_ID" so ' +
          'replayed sub-agent writes append to the calling session marker.',
      );
    });

    it('the Step 4.4 --scan-vault fence resolves its own paths via --sh', () => {
      // The 4.4 fence runs in its own shell and reads $VAULT/$SESSION_ID (and
      // sets LL_REFLECT_SID=$SESSION_ID). It does NOT build the reflect-scratch
      // prefix, so the per-fence-prefix test above never visits it. Pin its
      // resolver directly: dropping the `eval "$(...--sh)"` would leave $VAULT
      // and $SESSION_ID empty in this separate shell — the sweep would abort
      // (empty root) or run blind, sub-agent notes would stop reaching the
      // marker, and Step 4.6 refinement would go silent, all with green CI.
      const fence = extractFence(readFileSync(SKILL_PATH, 'utf8'), '--scan-vault "$VAULT"');
      assert.ok(fence, 'could not find the Step 4.4 --scan-vault bash fence');
      assert.ok(
        fence.body.includes('node "${CLAUDE_PLUGIN_ROOT}/scripts/resolve-paths.mjs" --sh'),
        'the Step 4.4 --scan-vault fence must resolve $VAULT/$SESSION_ID via ' +
          'resolve-paths.mjs --sh in its own shell — a dropped resolver silently ' +
          'unresolves the sweep and breaks the marker handshake + LL_REFLECT_SID routing.',
      );
    });

    it('runs 4.6.g cleanup even on the 0-candidate path (no permanent reflect_sid leak)', () => {
      // The leak fix: when refinement-pairs is [], the skill must skip 4.6.b-f
      // but STILL run 4.6.g (strip reflect_sid, remove the marker). The pre-fix
      // wording was "skip the rest of 4.6", which left every note's transient
      // reflect_sid stamp in the vault permanently on no-candidate runs. Pin the
      // corrected contract so a prose revert can't silently reintroduce the leak.
      const refinement = readFileSync(REFINEMENT_STEP_PATH, 'utf8');
      assert.match(
        refinement,
        /0 candidates in band[^\n]*Still run \*\*4\.6\.g cleanup\*\*/,
        'the empty-pairs branch must explicitly still run 4.6.g cleanup',
      );
      // The naive "skip the rest of 4.6" / "skip 4.6.g" must NOT reappear. Scope
      // the negative narrowly: the corrected prose legitimately says "skip
      // 4.6.b through 4.6.f", which must stay allowed.
      assert.doesNotMatch(
        refinement,
        /skip the rest of 4\.6\b/,
        'the empty-pairs branch must not skip the entire rest of 4.6 (that skips 4.6.g cleanup)',
      );
      assert.doesNotMatch(refinement, /skip 4\.6\.g/, '4.6.g cleanup must never be skipped');
    });

    it("selects sweep candidates by this session's reflect_sid via --scan-vault", () => {
      // The candidate union (link-less OR reflect_sid==session) now lives in
      // sweep-hook-replay.mjs --scan-vault (unit-tested in
      // sweep-scan-vault.test.mjs, including the 4-projects exclusion). The skill
      // must invoke that mode with the session id so well-formed (linked)
      // sub-agent notes are still swept by their stamp.
      assert.match(
        skill,
        /--scan-vault "\$VAULT" --sid "\$SESSION_ID"/,
        'Step 4.4 must invoke sweep-hook-replay.mjs --scan-vault with --sid "$SESSION_ID".',
      );
      // And the skill must instruct stamping reflect_sid on written notes.
      assert.match(
        skill,
        /Stamp `reflect_sid: <SESSION_ID>` in the frontmatter of every note/,
        'Step 4 must tell the agent to stamp reflect_sid on every note it writes.',
      );
    });

    it('resolves session paths via the canonical resolve-paths.mjs --sh resolver, not a cat of the id file', () => {
      // Both sides must run the SAME resolver. The skill shells to
      // resolve-paths.mjs --sh (whose SESSION_ID calls getSessionId(),
      // REFLECT_SCRATCH mirrors reflectScratchDir()); the hook calls those
      // directly. Pin the exact snippet so a future edit can't drop back to
      // `cat`-ing the id file under an env-dependent path.
      const snippet = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/resolve-paths.mjs" --sh';
      assert.ok(
        skill.includes(snippet),
        'expected the canonical resolve-paths.mjs --sh resolver snippet somewhere in the reflect skill',
      );
      // The old env-dependent cat-of-the-id-file pattern must be gone entirely.
      assert.doesNotMatch(
        skill,
        /cat "\$\{TMPDIR:-\/tmp\}\/learning-loop-session-id"/,
        'no block may cat the id file under $TMPDIR — hook subprocesses resolve a ' +
          'different $TMPDIR, so this re-splits the handshake. Use resolve-paths.mjs SESSION_ID.',
      );
      assert.doesNotMatch(
        skill,
        /ll-\$\{CLAUDE_CODE_SESSION_ID/,
        'no reflect path may key off $CLAUDE_CODE_SESSION_ID — it diverges from the hook',
      );
    });
  });

  describe('cross-process agreement (the actual handshake)', () => {
    it('skill-side resolve-paths.mjs and hook-side reflectNewNotesPath() land on the same marker, even with divergent $TMPDIR', async () => {
      // The whole bug class is the skill and the hook resolving the marker path
      // in SEPARATE processes. This test reproduces that split for real: it
      // spawns resolve-paths.mjs as its own process (what the skill's bash does)
      // and gives that child a DIFFERENT $TMPDIR than this process — the exact
      // production asymmetry that broke BOTH the tmp-anchored dir AND the
      // tmpdir-keyed session id. With plugin-data anchoring the dir (REFLECT_SCRATCH)
      // and the id (getSessionId() reads plugin-data/session/id first), both
      // sides must build byte-for-byte the same marker. Seed ONLY plugin-data —
      // the tmp files must be irrelevant.
      const sessionDir = join(pluginData, 'session');
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, 'id'), 'crossproc-sid');
      rmSync(sidFileBare, { force: true });

      const resolvePaths = join(__dirname, '..', 'plugin', 'scripts', 'resolve-paths.mjs');
      const childEnv = { ...process.env, TMPDIR: join(tmpRoot, 'child-sees-a-different-tmpdir') };

      // Skill side: build the marker exactly as SKILL.md's bash does — via the
      // --sh export the fences run (`eval "$(resolve-paths.mjs --sh)"`), parsing
      // SESSION_ID/REFLECT_SCRATCH out of it, NOT the single-field mode.
      const shOut = execFileSync('node', [resolvePaths, '--sh'], {
        encoding: 'utf8',
        env: childEnv,
      });
      const sh = Object.fromEntries(
        shOut
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const eq = line.indexOf('=');
            return [
              line.slice(0, eq),
              line
                .slice(eq + 1)
                .replace(/^'|'$/g, '')
                .replace(/'\\''/g, "'"),
            ];
          }),
      );
      const skillSid = sh.SESSION_ID;
      const skillScratch = sh.REFLECT_SCRATCH;
      const skillMarker = join(skillScratch, `ll-${skillSid}-reflect-new-notes.txt`);

      // Hook side: reflectNewNotesPath() in THIS process (its own $TMPDIR).
      const { reflectNewNotesPath } = await import(
        '../plugin/hooks/modules/reflect-track.mjs?bust=xproc' + Date.now()
      );
      const hookMarker = reflectNewNotesPath();

      assert.equal(
        skillMarker,
        hookMarker,
        'skill-side (separate process, divergent $TMPDIR) and hook-side must resolve ' +
          'the identical marker path; divergence here IS the empty-handshake bug',
      );
      assert.equal(skillSid, 'crossproc-sid');
      assert.equal(skillScratch, scratchDir, 'scratch dir must be plugin-data/reflect-scratch');
    });
  });

  describe('hook handshake (hooks/modules/reflect-track.mjs)', () => {
    let runReflectTrack;
    let reflectNewNotesPath;

    before(async () => {
      // Reset session-id state the cross-process test mutated: clear any
      // plugin-data sid it seeded and restore the tmp sid file this suite's
      // outer before() relies on.
      rmSync(join(pluginData, 'session'), { recursive: true, force: true });
      writeFileSync(sidFileBare, SID);
      // Fresh import so the module re-reads env at call time.
      const mod = await import('../plugin/hooks/modules/reflect-track.mjs?bust=' + Date.now());
      runReflectTrack = mod.runReflectTrack;
      reflectNewNotesPath = mod.reflectNewNotesPath;
    });

    beforeEach(() => {
      const marker = reflectNewNotesPath();
      if (existsSync(marker)) rmSync(marker);
    });

    it('computes the marker under plugin-data/reflect-scratch', () => {
      const expected = join(scratchDir, `ll-${SID}-reflect-new-notes.txt`);
      assert.equal(reflectNewNotesPath(), expected);
    });

    it('ignores $TMPDIR entirely — the two-process-split regression', () => {
      // The core production bug: the reader (interactive shell) had
      // $TMPDIR=/tmp/claude-501 while the writer (hook subprocess) had it unset;
      // os.tmpdir() honors $TMPDIR, so a tmp-anchored marker diverged. Aligning
      // the *formula* (process.env.TMPDIR || tmpdir()) on both sides did NOT
      // help, because the two subprocesses evaluate it differently. The
      // plugin-data anchor is the fix: changing $TMPDIR must not move the path.
      // Pass an explicit sid so only the DIR resolution is under test (varying
      // $TMPDIR would otherwise also move where getSessionId() looks for its id
      // file, confounding the dir check).
      const sid = 'tmpdir-immune-sid';
      const base = reflectNewNotesPath(sid);
      assert.equal(base, join(scratchDir, `ll-${sid}-reflect-new-notes.txt`));
      const saved = process.env.TMPDIR;
      try {
        process.env.TMPDIR = join(tmpRoot, 'a-totally-different-dir');
        assert.equal(
          reflectNewNotesPath(sid),
          base,
          '$TMPDIR must not influence the marker path; the hook and skill resolve ' +
            'the dir via plugin-data, which is identical across subprocesses',
        );
        delete process.env.TMPDIR;
        assert.equal(
          reflectNewNotesPath(sid),
          base,
          'unsetting $TMPDIR (as a hook subprocess sees it) must also leave the path unchanged',
        );
      } finally {
        if (saved !== undefined) process.env.TMPDIR = saved;
        else delete process.env.TMPDIR;
      }
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
        await runReflectTrack({
          tool: 'Write',
          input: { file_path: fp },
          vaultRoot: fakeVaultRoot,
        });
      }

      const lines = readFileSync(marker, 'utf8').trimEnd().split('\n');
      assert.equal(
        lines.length,
        writes.length,
        `expected ${writes.length} lines, got ${lines.length}`,
      );
      for (let i = 0; i < writes.length; i++) assert.equal(lines[i], writes[i]);
    });

    it('does not re-append a path the marker already holds', async () => {
      // Regression (root-caused 2026-07-28): every main-thread note reached the
      // marker TWICE. The live PostToolUse hook appends on the Write; then Step
      // 4.4's sweep replays post-tool.js on the same note and appends again,
      // because the 4.4 candidate union matches `unlinked || reflect_sid==sid`
      // and SKILL.md tells the agent to stamp reflect_sid on EVERY note it
      // writes — including its own main-thread Writes, which the live hook
      // already captured. The marker is a SET of paths, so the single writer
      // must not add one it already holds.
      const marker = reflectNewNotesPath();
      writeFileSync(marker, '');

      const fp = join(fakeVaultRoot, '0-inbox', 'written-then-swept.md');
      const ctx = { tool: 'Write', input: { file_path: fp }, vaultRoot: fakeVaultRoot };

      await runReflectTrack(ctx); // live hook on the main-thread Write
      await runReflectTrack(ctx); // Step 4.4 replay on the same note

      const lines = readFileSync(marker, 'utf8')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      assert.deepEqual(
        lines,
        [fp],
        'the replay must not duplicate a path the live hook already recorded — ' +
          'duplicates make refinement-candidates.mjs query and propose the pair twice',
      );
    });

    it('still records distinct paths after a duplicate is suppressed', async () => {
      // The dedup must be per-path, not "append at most once per marker".
      const marker = reflectNewNotesPath();
      writeFileSync(marker, '');

      const a = join(fakeVaultRoot, '0-inbox', 'dedup-a.md');
      const b = join(fakeVaultRoot, '0-inbox', 'dedup-b.md');
      for (const fp of [a, a, b, a, b]) {
        await runReflectTrack({
          tool: 'Write',
          input: { file_path: fp },
          vaultRoot: fakeVaultRoot,
        });
      }

      const lines = readFileSync(marker, 'utf8')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      assert.deepEqual(lines, [a, b], 'each distinct path recorded once, in first-seen order');
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

  // Regression (root-caused 2026-06-03): the marker handshake broke a THIRD
  // time. getSessionId() keyed candidates on process.ppid (id-<ppid> first),
  // but ppid is the immediate parent and differs per process — the hook's
  // parent is the harness, the skill's node's parent is its bash — so the
  // writer and reader never shared a ppid file; they only met by falling
  // through to the unsuffixed `id`. Worse, id-<ppid> files accumulated forever
  // (18 stale ones in the wild, ppids reused across sessions) and a stale one
  // shadowed the real id, re-splitting the handshake → empty marker, refinement
  // silently skipped. Fix: $CLAUDE_CODE_SESSION_ID — the one id identical across
  // every process in a session and independent of both $TMPDIR and ppid — is now
  // the canonical key getSessionId() returns. These tests pin that the marker
  // keys off the harness id, an explicit arg still overrides, the resolver falls
  // through to disk/'unknown' when the var is absent, and the marker round-trips
  // through the same path on both sides.
  describe('session-id resolution via canonical getSessionId()', () => {
    let runReflectTrack;
    let reflectNewNotesPath;
    let savedSid;

    before(async () => {
      savedSid = process.env.CLAUDE_CODE_SESSION_ID;
      const mod = await import('../plugin/hooks/modules/reflect-track.mjs?bust=file' + Date.now());
      runReflectTrack = mod.runReflectTrack;
      reflectNewNotesPath = mod.reflectNewNotesPath;
    });

    after(() => {
      if (savedSid !== undefined) process.env.CLAUDE_CODE_SESSION_ID = savedSid;
      else delete process.env.CLAUDE_CODE_SESSION_ID;
      writeFileSync(sidFileBare, SID);
    });

    it('keys the marker off $CLAUDE_CODE_SESSION_ID (the canonical session id)', () => {
      process.env.CLAUDE_CODE_SESSION_ID = 'harness-sid-abc123';
      const expected = join(scratchDir, 'll-harness-sid-abc123-reflect-new-notes.txt');
      assert.equal(reflectNewNotesPath(), expected);
    });

    it('honors an explicit sessionId argument over the resolver', () => {
      process.env.CLAUDE_CODE_SESSION_ID = 'harness-sid-abc123';
      const realSid = 'f7ad287f-2e93-473c-8c83-dd8e0380fc2c';
      assert.equal(
        reflectNewNotesPath(realSid),
        join(scratchDir, `ll-${realSid}-reflect-new-notes.txt`),
      );
    });

    it('falls back to getSessionId()\'s "unknown" sentinel when neither env var nor id file exists', () => {
      // getSessionId() returns 'unknown' outside a Claude Code session; the
      // marker path keys on that. The skill's resolve-paths.mjs SESSION_ID
      // returns the same value, so both sides still meet.
      delete process.env.CLAUDE_CODE_SESSION_ID;
      rmSync(sidFileBare, { force: true });
      assert.equal(reflectNewNotesPath(), join(scratchDir, 'll-unknown-reflect-new-notes.txt'));
    });

    it('appends to the skill-created marker when both sides resolve the same id', async () => {
      // Mirror production: post-tool.js passes sessionId:null, so the hook
      // resolves the path purely from getSessionId() — the same resolver the
      // skill's bash runs via resolve-paths.mjs SESSION_ID. The harness session
      // id is identical in both processes, so they land on the same marker.
      process.env.CLAUDE_CODE_SESSION_ID = 'shared-sid-xyz';
      const skillMarker = join(scratchDir, 'll-shared-sid-xyz-reflect-new-notes.txt');
      mkdirSync(scratchDir, { recursive: true });
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
        'hook must append to the path the skill built from the canonical resolver',
      );
      rmSync(skillMarker);
    });
  });

  // Regression (root-caused 2026-06-02): subagent-written notes (note-writer,
  // discovery-researcher, literature-capturer) never reached the marker, so
  // Step 4.6 upstream-refinement silently skipped on every research-heavy
  // /reflect. PostToolUse hooks don't fire on subagent tool calls; the only
  // backfill was Step 4.4's sweep, whose candidate filter selected ONLY
  // notes with no [[links]] (it exists for autolink backfill). capture-rules
  // requires at least one link and note-writer always emits one, so every
  // well-formed note was filtered out → never replayed → marker stayed empty.
  //
  // Fix: the replay (sweep-hook-replay.mjs) forwards LL_REFLECT_SID, which
  // post-tool.js reads into ctx.sessionId, which reflect-track.mjs honors as
  // the explicit session override. The skill sets LL_REFLECT_SID=$LL_SID and
  // feeds ALL session notes (not just link-less ones) to the replay. The
  // explicit id is also what makes attribution correct under concurrent
  // /reflect runs, where getSessionId()'s unsuffixed plugin-data id is
  // last-writer-wins and would misattribute the write to the other session.
  describe('subagent-write backfill via LL_REFLECT_SID (Step 4.4 sweep)', () => {
    let runReflectTrack;
    let reflectNewNotesPath;
    let savedReflectSid;

    before(async () => {
      savedReflectSid = process.env.LL_REFLECT_SID;
      // Seed getSessionId() to resolve a DIFFERENT id than the reflect session —
      // simulating a concurrent session that started later (last-writer-wins on
      // the unsuffixed plugin-data id). The fix must ignore this and key off
      // LL_REFLECT_SID instead.
      writeFileSync(sidFileBare, 'other-concurrent-session');
      const mod = await import(
        '../plugin/hooks/modules/reflect-track.mjs?bust=reflectsid' + Date.now()
      );
      runReflectTrack = mod.runReflectTrack;
      reflectNewNotesPath = mod.reflectNewNotesPath;
    });

    after(() => {
      if (savedReflectSid !== undefined) process.env.LL_REFLECT_SID = savedReflectSid;
      else delete process.env.LL_REFLECT_SID;
      writeFileSync(sidFileBare, SID);
    });

    it('appends a subagent (linked) note to the CALLING session marker, not the concurrent one', async () => {
      // The reflect session's own marker, keyed on ITS id.
      const reflectSid = 'my-reflect-session';
      const myMarker = join(scratchDir, `ll-${reflectSid}-reflect-new-notes.txt`);
      mkdirSync(scratchDir, { recursive: true });
      writeFileSync(myMarker, '');

      // A note exactly like note-writer produces: it HAS a [[link]] (so the old
      // link-less sweep filter would have skipped it). Path is what matters here.
      const fp = join(fakeVaultRoot, '0-inbox', 'linked-subagent-note.md');

      // Replay path: post-tool.js would pass ctx.sessionId = env.LL_REFLECT_SID.
      // Drive reflect-track directly with that explicit override (the unit under
      // test) — the value the skill set and the replay forwarded.
      await runReflectTrack({
        tool: 'Write',
        input: { file_path: fp },
        vaultRoot: fakeVaultRoot,
        sessionId: reflectSid,
      });

      assert.equal(
        readFileSync(myMarker, 'utf8'),
        fp + '\n',
        'explicit sessionId override must route the append to the reflect session marker',
      );

      // And it must NOT have leaked into the concurrent session's marker.
      const otherMarker = join(scratchDir, 'll-other-concurrent-session-reflect-new-notes.txt');
      assert.equal(
        existsSync(otherMarker),
        false,
        "the write must not land in the concurrent session's marker (getSessionId() target)",
      );
      rmSync(myMarker);
    });

    it('end-to-end: sweep-hook-replay.mjs with LL_REFLECT_SID set populates the marker', () => {
      // The real integration: spawn sweep-hook-replay.mjs exactly as Step 4.4
      // does, with LL_REFLECT_SID in the env, and assert the marker gets the
      // replayed note path. This proves the full env → post-tool.js → reflect-
      // track.mjs plumbing, not just the module override.
      const reflectSid = 'e2e-reflect-sid';
      const marker = join(scratchDir, `ll-${reflectSid}-reflect-new-notes.txt`);
      mkdirSync(scratchDir, { recursive: true });
      writeFileSync(marker, '');

      // A real on-disk note inside the fake vault (replay reads file content).
      const inbox = join(fakeVaultRoot, '0-inbox');
      mkdirSync(inbox, { recursive: true });
      const notePath = join(inbox, 'e2e-linked-note.md');
      writeFileSync(
        notePath,
        '---\ntags: [test]\n---\n\nBody with a [[wikilink]] so the old filter would skip it.\n',
      );

      const replay = join(__dirname, '..', 'plugin', 'scripts', 'sweep-hook-replay.mjs');
      // The replay's child post-tool.js resolves the vault from config; point it
      // at the fake vault via VAULT_PATH (getVaultPath() reads it first).
      const childEnv = {
        ...process.env,
        LL_REFLECT_SID: reflectSid,
        VAULT_PATH: fakeVaultRoot,
        CLAUDE_PLUGIN_DATA: pluginData,
      };
      execFileSync('node', [replay, notePath], { encoding: 'utf8', env: childEnv });

      const contents = readFileSync(marker, 'utf8');
      assert.ok(
        contents.includes(notePath),
        `marker must contain the replayed note path via LL_REFLECT_SID; got: ${JSON.stringify(contents)}`,
      );
      rmSync(marker);
    });
  });
});
