import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
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
