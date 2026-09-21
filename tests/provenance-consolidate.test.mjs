// tests/provenance-consolidate.test.mjs
// provenance-consolidate.mjs aggregates raw provenance events into
// federation/provenance-local.json. Covers T1g (dead counters replaced with
// real ones) and T1h (federation output shape stays honest about which
// dimension a count came from).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { VALID_ACTIONS, LEGACY_ACTIONS } from '../plugin/scripts/lib/provenance-vocabulary.mjs';

const CONSOLIDATE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'plugin',
  'scripts',
  'provenance-consolidate.mjs',
);

function withEvents(events, fn) {
  const root = mkdtempSync(join(tmpdir(), 'll-consolidate-'));
  try {
    const dir = join(root, 'provenance');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'events-2026-05.jsonl'), events.map((e) => JSON.stringify(e)).join('\n'));
    const result = spawnSync('node', [CONSOLIDATE], {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: root },
      encoding: 'utf-8',
    });
    return fn(result, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('batch-promote produces a non-zero promotion count', () => {
  const events = [
    { ts: '2026-05-01T00:00:00Z', action: 'batch-promote', session_id: 's1', agent: 'verify' },
    { ts: '2026-05-01T00:00:01Z', action: 'batch-promote', session_id: 's1', agent: 'verify' },
  ];

  withEvents(events, ({ status, stdout, stderr }) => {
    assert.strictEqual(status, 0, `unexpected exit: ${stderr}`);
    const output = JSON.parse(stdout);
    const day = output.summaries[0];
    const agentBucket = day.agents.verify;
    assert.ok(agentBucket, 'expected an agents.verify bucket');
    assert.strictEqual(agentBucket.promotions, 2);
  });
});

test('no counter counts an action absent from VALID_ACTIONS or LEGACY_ACTIONS', () => {
  // fix and verify-fix have no emitter anywhere in the codebase and are not
  // in the committed vocabulary; promote only ever appears nested inside a
  // batch-score payload, never as a top-level action. None of these three may
  // move a counter.
  const events = [
    { ts: '2026-05-01T00:00:00Z', action: 'fix', session_id: 's1', agent: 'verify' },
    { ts: '2026-05-01T00:00:01Z', action: 'verify-fix', session_id: 's1', agent: 'verify' },
    { ts: '2026-05-01T00:00:02Z', action: 'promote', session_id: 's1', agent: 'verify' },
  ];

  withEvents(events, ({ status, stdout, stderr }) => {
    assert.strictEqual(status, 0, `unexpected exit: ${stderr}`);
    const output = JSON.parse(stdout);
    // None of fix, verify-fix or promote are in VALID_ACTIONS/LEGACY_ACTIONS,
    // so the whole day is skipped: no bucket exists at all to hold a phantom
    // count for them.
    assert.deepStrictEqual(output.summaries, []);

    for (const action of [...VALID_ACTIONS, ...LEGACY_ACTIONS]) {
      assert.notStrictEqual(action, 'fix');
      assert.notStrictEqual(action, 'verify-fix');
      assert.notStrictEqual(action, 'promote');
    }
  });
});

test('an event with only agent lands in the agent bucket, not a bucket labelled as skill', () => {
  const events = [
    { ts: '2026-05-01T00:00:00Z', action: 'agent-result', session_id: 's1', agent: 'note-scorer' },
  ];

  withEvents(events, ({ status, stdout, stderr }) => {
    assert.strictEqual(status, 0, `unexpected exit: ${stderr}`);
    const output = JSON.parse(stdout);
    const day = output.summaries[0];
    assert.ok(day.agents && day.agents['note-scorer'], 'expected agents.note-scorer bucket');
    assert.ok(!day.skills || !day.skills['note-scorer'], 'must not also appear under skills');
  });
});

test('an event with only skill lands in the skill bucket', () => {
  const events = [
    { ts: '2026-05-01T00:00:00Z', action: 'vault-write', session_id: 's1', skill: 'reflect' },
  ];

  withEvents(events, ({ status, stdout, stderr }) => {
    assert.strictEqual(status, 0, `unexpected exit: ${stderr}`);
    const output = JSON.parse(stdout);
    const day = output.summaries[0];
    assert.ok(day.skills && day.skills.reflect, 'expected skills.reflect bucket');
    assert.strictEqual(day.skills.reflect.notes_created, 1);
  });
});

test('an event with neither skill nor agent falls back to action, labelled honestly', () => {
  const events = [
    { ts: '2026-05-01T00:00:00Z', action: 'session-start', session_id: 's1' },
  ];

  withEvents(events, ({ status, stdout, stderr }) => {
    assert.strictEqual(status, 0, `unexpected exit: ${stderr}`);
    const output = JSON.parse(stdout);
    const day = output.summaries[0];
    assert.ok(day.actions && day.actions['session-start'], 'expected actions["session-start"] bucket');
  });
});

test('legacy actions in historical data aggregate without throwing', () => {
  const events = [
    { ts: '2026-05-01T00:00:00Z', action: 'write-note', session_id: 's1', agent: 'legacy' },
    { ts: '2026-05-01T00:00:01Z', action: 'demote', session_id: 's1', agent: 'legacy' },
  ];

  withEvents(events, ({ status, stderr }) => {
    assert.strictEqual(status, 0, `must not throw on legacy actions: ${stderr}`);
  });
});
