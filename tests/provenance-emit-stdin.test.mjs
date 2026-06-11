import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const EMIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'scripts', 'provenance-emit.js');

function readEvents(root) {
  const dir = join(root, 'provenance');
  return readdirSync(dir)
    .filter((f) => f.startsWith('events-') && f.endsWith('.jsonl'))
    .flatMap((f) =>
      readFileSync(join(dir, f), 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    );
}

test('provenance-emit.js - reads the JSON payload from stdin (prose-safe form)', () => {
  const root = mkdtempSync(join(tmpdir(), 'll-prov-stdin-'));
  try {
    const payload = {
      agent: 'note-verifier',
      skill: 'verify',
      action: 'score',
      finding_detail: `claim says "30–60s"; source's table 2 disagrees ($PATH-like text, \`backticks\`)`,
    };
    const result = spawnSync('node', [EMIT, '-'], {
      input: JSON.stringify(payload),
      env: { ...process.env, CLAUDE_PLUGIN_DATA: root },
      encoding: 'utf-8',
    });
    assert.strictEqual(result.status, 0, `provenance-emit.js exited ${result.status}: ${result.stderr}`);

    const events = readEvents(root);
    assert.strictEqual(events.length, 1, 'expected exactly one event from stdin payload');
    assert.strictEqual(events[0].agent, 'note-verifier');
    assert.strictEqual(events[0].finding_detail, payload.finding_detail);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provenance-emit.js argv form still works', () => {
  const root = mkdtempSync(join(tmpdir(), 'll-prov-argv-'));
  try {
    const result = spawnSync(
      'node',
      [EMIT, JSON.stringify({ agent: 'test', action: 'create', target: 'x.md' })],
      { env: { ...process.env, CLAUDE_PLUGIN_DATA: root }, encoding: 'utf-8' },
    );
    assert.strictEqual(result.status, 0, `provenance-emit.js exited ${result.status}: ${result.stderr}`);
    const events = readEvents(root);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].target, 'x.md');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
