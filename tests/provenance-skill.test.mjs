// tests/provenance-skill.test.mjs
// Covers the shared skill-derivation helper (scripts/lib/provenance-skill.mjs)
// and both emitProvenance call sites that use it: a caller that omits `skill`
// gains it from the session's current-skill marker; session-summary and
// session-start never gain one even when a marker is present.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeMarker, MARKER_PATHS } from '../plugin/scripts/lib/marker-cache.mjs';
import { deriveSkill } from '../plugin/scripts/lib/provenance-skill.mjs';

describe('deriveSkill (unit)', () => {
  let dataDir;
  before(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'll-derive-skill-'));
  });
  after(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('fills skill from the marker when the record omits it', () => {
    writeMarker(MARKER_PATHS.currentSkill(dataDir, 's1'), {
      skill: 'learning-loop:deepen',
      ts: Date.now(),
    });
    const record = { action: 'vault-write', session_id: 's1' };
    deriveSkill(record, dataDir);
    assert.equal(record.skill, 'learning-loop:deepen');
  });

  it('leaves skill absent when there is no marker', () => {
    const record = { action: 'vault-write', session_id: 'no-marker-session' };
    deriveSkill(record, dataDir);
    assert.ok(!('skill' in record));
  });

  it('never derives onto session-summary or session-start', () => {
    writeMarker(MARKER_PATHS.currentSkill(dataDir, 's2'), {
      skill: 'learning-loop:deepen',
      ts: Date.now(),
    });
    const summary = { action: 'session-summary', session_id: 's2' };
    deriveSkill(summary, dataDir);
    assert.ok(!('skill' in summary));
    const start = { action: 'session-start', session_id: 's2' };
    deriveSkill(start, dataDir);
    assert.ok(!('skill' in start));
  });

  it('does not overwrite a skill the caller already set', () => {
    writeMarker(MARKER_PATHS.currentSkill(dataDir, 's3'), {
      skill: 'learning-loop:deepen',
      ts: Date.now(),
    });
    const record = { action: 'vault-write', session_id: 's3', skill: 'learning-loop:verify' };
    deriveSkill(record, dataDir);
    assert.equal(record.skill, 'learning-loop:verify');
  });
});

describe('emitProvenance derives skill from the marker (hooks/lib/common.mjs)', () => {
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

  function readEvents() {
    const dir = join(dataDir, 'provenance');
    const files = readdirSync(dir).filter((f) => f.startsWith('events-'));
    return files.flatMap((f) =>
      readFileSync(join(dir, f), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    );
  }

  it('a vault-write gains skill when the current-skill marker is present', async () => {
    writeMarker(MARKER_PATHS.currentSkill(dataDir, 'sess-with-marker'), {
      skill: 'learning-loop:reflect',
      ts: Date.now(),
    });
    const mod = await import('../plugin/hooks/lib/common.mjs?bust=derive1');
    mod.emitProvenance({
      session_id: 'sess-with-marker',
      action: 'vault-write',
      target: '0-inbox/a.md',
    });
    const event = readEvents().find((e) => e.session_id === 'sess-with-marker');
    assert.equal(event.skill, 'learning-loop:reflect');
  });

  it('a vault-write has no skill field when there is no marker', async () => {
    const mod = await import('../plugin/hooks/lib/common.mjs?bust=derive2');
    mod.emitProvenance({
      session_id: 'sess-without-marker',
      action: 'vault-write',
      target: '0-inbox/b.md',
    });
    const event = readEvents().find((e) => e.session_id === 'sess-without-marker');
    assert.ok(!('skill' in event));
  });

  it('a session-summary never gains a skill even with a marker present', async () => {
    writeMarker(MARKER_PATHS.currentSkill(dataDir, 'sess-summary'), {
      skill: 'learning-loop:reflect',
      ts: Date.now(),
    });
    const mod = await import('../plugin/hooks/lib/common.mjs?bust=derive3');
    mod.emitProvenance({
      session_id: 'sess-summary',
      action: 'session-summary',
      final: true,
      prompts: 1,
    });
    const event = readEvents().find(
      (e) => e.session_id === 'sess-summary' && e.action === 'session-summary',
    );
    assert.ok(!('skill' in event));
  });
});
