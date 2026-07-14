import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPORT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'plugin',
  'scripts',
  'provenance-report.mjs',
);

function withProvenance(events, fn) {
  const root = mkdtempSync(join(tmpdir(), 'll-prov-'));
  try {
    const dir = join(root, 'provenance');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'events-2026-05.jsonl'), events.map((e) => JSON.stringify(e)).join('\n'));
    const result = spawnSync('node', [REPORT], {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: root },
      encoding: 'utf-8',
    });
    return fn(result);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('joins score.target (basename) to vault-write.target (path) — config correlation populates', () => {
  const events = [
    { ts: '2026-05-01T00:00:00Z', action: 'session-start', session_id: 's1', skill: 'discovery', config: { depth: 'default' } },
    { ts: '2026-05-01T00:00:01Z', action: 'session-start', session_id: 's2', skill: 'reflect', config: { depth: 'default' } },
    { ts: '2026-05-01T00:01:00Z', action: 'vault-write', session_id: 's1', target: '0-inbox/note-a.md', folder: 'inbox' },
    { ts: '2026-05-01T00:01:01Z', action: 'vault-write', session_id: 's2', target: '0-inbox/note-b.md', folder: 'inbox' },
    { ts: '2026-05-01T00:01:02Z', action: 'vault-write', session_id: 's2', target: '0-inbox/note-c.md', folder: 'inbox' },
    { ts: '2026-05-01T00:02:00Z', action: 'score', target: 'note-a.md', result: 'fail', finding_type: 'overclaim', trigger: 'verify-auto' },
    { ts: '2026-05-01T00:02:01Z', action: 'score', target: 'note-b.md', result: 'pass', trigger: 'verify-auto' },
  ];

  withProvenance(events, ({ status, stdout, stderr }) => {
    assert.strictEqual(status, 0, `report exited ${status}: ${stderr}`);
    assert.match(stdout, /discovery depth=default: 1\/1 flagged \(100%\)/);
    assert.match(stdout, /reflect depth=default: 0\/2 flagged \(0%\)/);
  });
});

test('unverified backlog excludes scored notes (regression: path-vs-basename mismatch)', () => {
  const events = [
    { ts: '2026-05-01T00:00:00Z', action: 'session-start', session_id: 's1', skill: 'discovery', config: {} },
    { ts: '2026-05-01T00:01:00Z', action: 'vault-write', session_id: 's1', target: '0-inbox/scored.md', folder: 'inbox' },
    { ts: '2026-05-01T00:01:01Z', action: 'vault-write', session_id: 's1', target: '0-inbox/unscored.md', folder: 'inbox' },
    { ts: '2026-05-01T00:02:00Z', action: 'score', target: 'scored.md', result: 'pass', trigger: 'verify-auto' },
  ];

  withProvenance(events, ({ status, stdout }) => {
    assert.strictEqual(status, 0);
    assert.match(stdout, /Notes created: 2 \| Verified: 1 \| Unverified: 1/);
    assert.match(stdout, /1 notes have no verification scores/);
  });
});

test('counts verify-skill gate-shape scores alongside note-verifier result-shape scores', () => {
  const events = [
    { ts: '2026-05-01T00:00:00Z', action: 'session-start', session_id: 's1', skill: 'verify', config: { depth: 'default' } },
    { ts: '2026-05-01T00:01:00Z', action: 'vault-write', session_id: 's1', target: '0-inbox/note-verifier-pass.md', folder: 'inbox' },
    { ts: '2026-05-01T00:01:01Z', action: 'vault-write', session_id: 's1', target: '0-inbox/gate-pass.md', folder: 'inbox' },
    { ts: '2026-05-01T00:01:02Z', action: 'vault-write', session_id: 's1', target: '0-inbox/gate-fail.md', folder: 'inbox' },
    // note-verifier shape: {action:'score', result:'pass'|'fail', confidence:...}
    { ts: '2026-05-01T00:02:00Z', action: 'score', target: 'note-verifier-pass.md', result: 'pass', confidence: 'clear', trigger: 'verify-auto' },
    // verify-skill shape: {action:'score', gate:'N/6', tier:...} — no `result` field
    { ts: '2026-05-01T00:02:01Z', action: 'score', target: 'gate-pass.md', tier: 'deep', gate: '5/6', claim_specificity: 2, source_grounded: 2 },
    { ts: '2026-05-01T00:02:02Z', action: 'score', target: 'gate-fail.md', tier: 'shallow', gate: '2/6', claim_specificity: 0, source_grounded: 0 },
  ];

  withProvenance(events, ({ status, stdout, stderr }) => {
    assert.strictEqual(status, 0, `report exited ${status}: ${stderr}`);
    // All three scored notes count as verified; none are unverified.
    assert.match(stdout, /Notes created: 3 \| Verified: 3 \| Unverified: 0/);
    // gate 5/6 >= 4/6 -> pass (not flagged); gate 2/6 < 4/6 -> fail (flagged).
    // Only gate-fail.md should be flagged, so config correlation shows 1/3.
    assert.match(stdout, /verify depth=default: 1\/3 flagged \(33%\)/);
  });
});

test('dedupes a basename written across folders (inbox → permanent move)', () => {
  const events = [
    { ts: '2026-05-01T00:00:00Z', action: 'session-start', session_id: 's1', skill: 'reflect', config: {} },
    { ts: '2026-05-01T00:01:00Z', action: 'vault-write', session_id: 's1', target: '0-inbox/moved.md', folder: 'inbox' },
    { ts: '2026-05-01T00:01:01Z', action: 'vault-write', session_id: 's1', target: '3-permanent/moved.md', folder: 'permanent' },
  ];

  withProvenance(events, ({ status, stdout }) => {
    assert.strictEqual(status, 0);
    assert.match(stdout, /Notes created: 1 \|/);
  });
});
