import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('provenance dedupe', () => {
  let dataDir;
  let fakeHome;
  let savedHome;
  before(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'll-common-home-'));
    savedHome = process.env.HOME;
    process.env.HOME = fakeHome;

    dataDir = mkdtempSync(join(tmpdir(), 'll-common-test-'));
    process.env.CLAUDE_PLUGIN_DATA = dataDir;
  });
  after(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
    delete process.env.CLAUDE_PLUGIN_DATA;
    if (savedHome !== undefined) process.env.HOME = savedHome;
    else delete process.env.HOME;
  });

  it('writes one provenance line per unique (session_id, agent_id, path)', async () => {
    const mod = await import('../plugin/hooks/lib/common.mjs?bust=1');
    mod.emitProvenance({ session_id: 's1', agent_id: 'a1', path: '0-inbox/a.md', action: 'write' });
    mod.emitProvenance({ session_id: 's1', agent_id: 'a1', path: '0-inbox/a.md', action: 'write' });
    mod.emitProvenance({ session_id: 's1', agent_id: 'a1', path: '0-inbox/b.md', action: 'write' });
    const files = readdirSync(join(dataDir, 'provenance')).filter(f => f.startsWith('events-'));
    assert.equal(files.length, 1);
    const lines = readFileSync(join(dataDir, 'provenance', files[0]), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2, 'expected 2 records (duplicate dropped)');
  });
});

describe('getSessionId fallback chain', () => {
  // The two paths tried, in order. We poke ppid-suffixed + the legacy file
  // into a PRIVATE tmp dir to exercise each fallback rung. Missing files must not
  // log — provenance-emit was spewing ENOENT lines to stderr because every
  // fallback step ran through a `try { read } catch { logError }` block
  // even when "file absent" was the entirely expected branch.
  let sessionTmpDir;
  let legacyPath;
  let savedEnvSid;
  let savedSessionTmpDir;
  before(() => {
    sessionTmpDir = mkdtempSync(join(tmpdir(), 'll-common-session-tmp-'));
    legacyPath = join(sessionTmpDir, 'learning-loop-session-id');
    savedSessionTmpDir = process.env.LL_SESSION_TMP_DIR;
    process.env.LL_SESSION_TMP_DIR = sessionTmpDir;
    savedEnvSid = process.env.CLAUDE_CODE_SESSION_ID;
    delete process.env.CLAUDE_CODE_SESSION_ID;
  });
  after(() => {
    rmSync(sessionTmpDir, { recursive: true, force: true });
    if (savedSessionTmpDir !== undefined) process.env.LL_SESSION_TMP_DIR = savedSessionTmpDir;
    else delete process.env.LL_SESSION_TMP_DIR;
    if (savedEnvSid !== undefined) process.env.CLAUDE_CODE_SESSION_ID = savedEnvSid;
    else delete process.env.CLAUDE_CODE_SESSION_ID;
  });

  it('returns "unknown" silently when no session-id files exist', async () => {
    if (existsSync(legacyPath)) unlinkSync(legacyPath);

    const mod = await import('../plugin/hooks/lib/common.mjs?bust=2');
    const errs = [];
    const origErr = console.error;
    console.error = (...args) => errs.push(args.join(' '));
    try {
      const id = mod.getSessionId();
      assert.equal(id, 'unknown');
    } finally {
      console.error = origErr;
    }
    const enoentLines = errs.filter(l => l.includes('ENOENT'));
    assert.equal(
      enoentLines.length,
      0,
      `getSessionId must not log ENOENT for the expected missing-file case; saw:\n${enoentLines.join('\n')}`,
    );
  });

  it('prefers $CLAUDE_CODE_SESSION_ID over the legacy file', async () => {
    writeFileSync(legacyPath, 'legacy-session');
    process.env.CLAUDE_CODE_SESSION_ID = 'harness-session';
    try {
      const mod = await import('../plugin/hooks/lib/common.mjs?bust=3');
      assert.equal(mod.getSessionId(), 'harness-session');
    } finally {
      delete process.env.CLAUDE_CODE_SESSION_ID;
    }
  });

  it('falls back to the legacy file when the env var is absent', async () => {
    writeFileSync(legacyPath, 'legacy-only');
    const mod = await import('../plugin/hooks/lib/common.mjs?bust=4');
    assert.equal(mod.getSessionId(), 'legacy-only');
  });
});

describe('readFileTail', () => {
  let dir;
  let readFileTail;
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'll-common-tail-'));
    ({ readFileTail } = await import('../plugin/hooks/lib/common.mjs?bust=5'));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the whole file unchanged when smaller than maxBytes', () => {
    const p = join(dir, 'small.jsonl');
    writeFileSync(p, 'line one\nline two\nline three');
    assert.equal(readFileTail(p, 1024), 'line one\nline two\nline three');
  });

  it('drops the partial first line when the read starts mid-file', () => {
    const p = join(dir, 'big.jsonl');
    const lines = [];
    for (let i = 0; i < 100; i++) lines.push(`{"n":${i},"pad":"${'x'.repeat(50)}"}`);
    writeFileSync(p, lines.join('\n'));
    const tail = readFileTail(p, 300);
    const got = tail.split('\n');
    assert.ok(got.length >= 2, 'tail should contain complete lines');
    for (const l of got) JSON.parse(l); // every surviving line is complete JSON
    assert.equal(got[got.length - 1], lines[lines.length - 1]);
  });

  it('returns empty string when no newline falls inside the tail window', () => {
    const p = join(dir, 'one-giant-line.jsonl');
    writeFileSync(p, 'a'.repeat(10_000));
    assert.equal(readFileTail(p, 100), '');
  });

  it('cannot leak a torn multi-byte char: drop-through-newline removes the fragment', () => {
    const p = join(dir, 'multibyte.jsonl');
    // 4-byte emoji repeated; window lands mid-emoji on the first (dropped) line.
    writeFileSync(p, `${'\u{1F600}'.repeat(100)}\nfinal line`);
    const tail = readFileTail(p, 17); // 'final line' is 10 bytes; 17 starts mid-emoji
    assert.equal(tail, 'final line');
  });
});
