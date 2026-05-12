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
    const mod = await import('../hooks/lib/common.mjs?bust=1');
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
  // into tmpdir() to exercise each fallback rung. Missing files must not
  // log — provenance-emit was spewing ENOENT lines to stderr because every
  // fallback step ran through a `try { read } catch { logError }` block
  // even when "file absent" was the entirely expected branch.
  const ppidPath = join(tmpdir(), `learning-loop-session-id-${process.ppid}`);
  const legacyPath = join(tmpdir(), 'learning-loop-session-id');
  // Save original contents so we can restore the developer's real session
  // ids when the test suite finishes.
  let savedPpid = null;
  let savedLegacy = null;
  before(() => {
    if (existsSync(ppidPath)) savedPpid = readFileSync(ppidPath, 'utf8');
    if (existsSync(legacyPath)) savedLegacy = readFileSync(legacyPath, 'utf8');
  });
  after(() => {
    if (savedPpid !== null) writeFileSync(ppidPath, savedPpid);
    else if (existsSync(ppidPath)) unlinkSync(ppidPath);
    if (savedLegacy !== null) writeFileSync(legacyPath, savedLegacy);
    else if (existsSync(legacyPath)) unlinkSync(legacyPath);
  });

  it('returns "unknown" silently when no session-id files exist', async () => {
    if (existsSync(ppidPath)) unlinkSync(ppidPath);
    if (existsSync(legacyPath)) unlinkSync(legacyPath);

    const mod = await import('../hooks/lib/common.mjs?bust=2');
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

  it('prefers the ppid-suffixed file', async () => {
    writeFileSync(ppidPath, 'ppid-session');
    writeFileSync(legacyPath, 'legacy-session');
    const mod = await import('../hooks/lib/common.mjs?bust=3');
    assert.equal(mod.getSessionId(), 'ppid-session');
  });

  it('falls back to the legacy file when ppid file is missing', async () => {
    if (existsSync(ppidPath)) unlinkSync(ppidPath);
    writeFileSync(legacyPath, 'legacy-only');
    const mod = await import('../hooks/lib/common.mjs?bust=4');
    assert.equal(mod.getSessionId(), 'legacy-only');
  });
});
