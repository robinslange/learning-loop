// tests/provenance-skill.test.mjs
// Covers the shared skill-derivation helper (scripts/lib/provenance-skill.mjs)
// and both emitProvenance call sites that use it: a caller that omits `skill`
// gains it from the session's current-skill marker; session-summary and
// session-start never gain one even when a marker is present. Also covers
// shape-based validation: any skill value (caller-supplied or derived) that
// is not a well-formed `name` or `plugin:name` identifier becomes 'unknown'.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeMarker, MARKER_PATHS, readMarker } from '../plugin/scripts/lib/marker-cache.mjs';
import {
  deriveSkill,
  normaliseSkill,
  normaliseAgent,
} from '../plugin/scripts/lib/provenance-skill.mjs';
import { pluginRoot } from '../plugin/scripts/lib/plugin-meta.mjs';

describe('normaliseSkill', () => {
  it('normalises a learning-loop-prefixed skill to its bare name', () => {
    assert.equal(normaliseSkill('learning-loop:reflect', pluginRoot()), 'reflect');
  });

  it('normalises a bare learning-loop skill to itself', () => {
    assert.equal(normaliseSkill('reflect', pluginRoot()), 'reflect');
  });

  it("keeps another plugin's prefixed identifier as-is, lower-cased", () => {
    assert.equal(
      normaliseSkill('superpowers:brainstorming', pluginRoot()),
      'superpowers:brainstorming',
    );
    assert.equal(
      normaliseSkill('Episodic-Memory:Remembering-Conversations', pluginRoot()),
      'episodic-memory:remembering-conversations',
    );
  });

  it('keeps a bare non-learning-loop identifier as-is', () => {
    assert.equal(normaliseSkill('update-config', pluginRoot()), 'update-config');
  });

  it('rejects free text that is not an identifier shape', () => {
    assert.equal(normaliseSkill('/anything free text', pluginRoot()), null);
    assert.equal(normaliseSkill('a b', pluginRoot()), null);
    assert.equal(normaliseSkill('x:y:z', pluginRoot()), null);
    assert.equal(normaliseSkill('../etc', pluginRoot()), null);
  });

  it('rejects an identifier over 128 characters', () => {
    assert.equal(normaliseSkill('a'.repeat(200), pluginRoot()), null);
  });
});

describe('normaliseAgent', () => {
  it('defaults an absent agent to general-purpose', () => {
    assert.equal(normaliseAgent(undefined), 'general-purpose');
    assert.equal(normaliseAgent(''), 'general-purpose');
  });

  it('keeps identifier-shaped agent names, up to three colon segments', () => {
    for (const v of [
      'general-purpose',
      'fm-adversarial-reviewer',
      'learning-loop:ingest-mapper-conventions',
      'learning-loop:_skills:extract-insights',
    ]) {
      assert.equal(normaliseAgent(v), v);
    }
  });

  it('rejects free text, paths and over-long values to unknown', () => {
    for (const v of [
      'refactor the billing module for acme corp',
      '/Users/robin/agents/x',
      'a:b:c:d',
      'x'.repeat(129),
      42,
    ]) {
      assert.equal(normaliseAgent(v), 'unknown');
    }
  });
});

describe('deriveSkill (unit)', () => {
  let dataDir;
  let savedEnv;
  before(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'll-derive-skill-'));
    // writeMarker no-ops unless plugin-data resolves to an existing dir (it
    // must never resurrect a deleted install), and it resolves that from the
    // env, not from the path being written. Without this the markers below
    // are silently never written: green locally only because a persisted
    // .ll-data-path under HOME points at a real install, red on any CI box.
    savedEnv = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = dataDir;
  });
  after(() => {
    if (savedEnv === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = savedEnv;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('fills skill from the marker when the record omits it', () => {
    writeMarker(MARKER_PATHS.currentSkill(dataDir, 's1'), {
      skill: 'learning-loop:deepen',
      ts: Date.now(),
    });
    const record = { action: 'vault-write', session_id: 's1' };
    deriveSkill(record, dataDir, pluginRoot());
    assert.equal(record.skill, 'deepen');
  });

  it('leaves skill absent when there is no marker', () => {
    const record = { action: 'vault-write', session_id: 'no-marker-session' };
    deriveSkill(record, dataDir, pluginRoot());
    assert.ok(!('skill' in record));
  });

  it('never derives onto session-summary or session-start', () => {
    writeMarker(MARKER_PATHS.currentSkill(dataDir, 's2'), {
      skill: 'learning-loop:deepen',
      ts: Date.now(),
    });
    const summary = { action: 'session-summary', session_id: 's2' };
    deriveSkill(summary, dataDir, pluginRoot());
    assert.ok(!('skill' in summary));
    const start = { action: 'session-start', session_id: 's2' };
    deriveSkill(start, dataDir, pluginRoot());
    assert.ok(!('skill' in start));
  });

  it('derives onto agent-result: the gap the plan named', () => {
    writeMarker(MARKER_PATHS.currentSkill(dataDir, 's-agent'), {
      skill: 'learning-loop:deepen',
      ts: Date.now(),
    });
    const record = { action: 'agent-result', session_id: 's-agent' };
    deriveSkill(record, dataDir, pluginRoot());
    assert.equal(record.skill, 'deepen');
  });

  it('normalises a caller-supplied skill rather than passing it through raw', () => {
    writeMarker(MARKER_PATHS.currentSkill(dataDir, 's3'), {
      skill: 'learning-loop:deepen',
      ts: Date.now(),
    });
    const record = { action: 'vault-write', session_id: 's3', skill: 'learning-loop:verify' };
    deriveSkill(record, dataDir, pluginRoot());
    assert.equal(record.skill, 'verify');
  });

  it('rejects an unrecognised caller-supplied skill as unknown', () => {
    const record = { action: 'vault-write', session_id: 's4', skill: '/anything free text' };
    deriveSkill(record, dataDir, pluginRoot());
    assert.equal(record.skill, 'unknown');
  });

  it('passes through a marker skill that is not one of ours but is well-shaped', () => {
    writeMarker(MARKER_PATHS.currentSkill(dataDir, 's5'), {
      skill: 'superpowers:brainstorming',
      ts: Date.now(),
    });
    const record = { action: 'vault-write', session_id: 's5' };
    deriveSkill(record, dataDir, pluginRoot());
    assert.equal(record.skill, 'superpowers:brainstorming');
  });

  it('rejects a malformed marker skill as unknown', () => {
    writeMarker(MARKER_PATHS.currentSkill(dataDir, 's6'), {
      skill: '/anything free text',
      ts: Date.now(),
    });
    const record = { action: 'vault-write', session_id: 's6' };
    deriveSkill(record, dataDir, pluginRoot());
    assert.equal(record.skill, 'unknown');
  });
});

describe('current-skill marker writer stores the normalised name', () => {
  it('normalises before writing', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'll-marker-writer-'));
    // Same plugin-data gate as above: writeMarker must see an existing dir.
    const savedEnv = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = dataDir;
    try {
      const normalised = normaliseSkill('learning-loop:reflect', pluginRoot());
      writeMarker(MARKER_PATHS.currentSkill(dataDir, 's1'), { skill: normalised, ts: Date.now() });
      const marker = readMarker(MARKER_PATHS.currentSkill(dataDir, 's1'));
      assert.equal(marker.skill, 'reflect');
    } finally {
      if (savedEnv === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = savedEnv;
      rmSync(dataDir, { recursive: true, force: true });
    }
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
    assert.equal(event.skill, 'reflect');
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
