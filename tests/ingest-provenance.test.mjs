import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const EMIT = join(import.meta.dirname, '..', 'plugin', 'scripts', 'provenance-emit.js');

test('an ingest run lands in the provenance events stream with its nested fields', () => {
  const root = mkdtempSync(join(tmpdir(), 'll-ingest-prov-'));
  try {
    const home = join(root, 'home');
    const data = join(root, 'data');
    mkdirSync(home);
    mkdirSync(data);
    const run = {
      agent: 'ingest',
      skill: 'ingest',
      action: 'ingest',
      slug: 'foo-abcdef',
      tier: 'parallel',
      gate_reason: 'files>400',
      override: null,
      mapper_summary: [{ mapper: 'arch', ok: true }],
      synthesizer: { insights: 3, note: "it's a monorepo" },
      duration_seconds: 100,
      ygrep_used: false,
      audit_ok: true,
      git_diff_outside: [],
    };
    const result = spawnSync('node', [EMIT, '-'], {
      input: JSON.stringify(run),
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, CLAUDE_PLUGIN_DATA: data },
      encoding: 'utf-8',
    });
    assert.equal(result.status, 0, result.stderr);

    const dir = join(data, 'provenance');
    const events = readdirSync(dir)
      .filter((f) => f.startsWith('events-'))
      .flatMap((f) => readFileSync(join(dir, f), 'utf-8').trim().split('\n'))
      .map((l) => JSON.parse(l));
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.action, 'ingest');
    assert.equal(event.source, 'skill');
    assert.deepEqual(event.mapper_summary, run.mapper_summary);
    assert.deepEqual(event.synthesizer, run.synthesizer);
    assert.equal(existsSync(join(data, 'ingest-provenance.jsonl')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
