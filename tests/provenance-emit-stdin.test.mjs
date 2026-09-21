import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const EMIT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'plugin',
  'scripts',
  'provenance-emit.js',
);

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
    assert.strictEqual(
      result.status,
      0,
      `provenance-emit.js exited ${result.status}: ${result.stderr}`,
    );

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
    assert.strictEqual(
      result.status,
      0,
      `provenance-emit.js exited ${result.status}: ${result.stderr}`,
    );
    const events = readEvents(root);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].target, 'x.md');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--text attaches a free-text field without the caller escaping it', () => {
  const root = mkdtempSync(join(tmpdir(), 'll-prov-text-'));
  try {
    // Every character the old heredoc instructions warned about, passed raw.
    const prose = `Claim 3 says "UCAST" is \`enterprise-only\`, cost $500\\1000, per O'Brien`;
    const result = spawnSync(
      'node',
      [
        EMIT,
        JSON.stringify({ agent: 'verify', skill: 'verify', action: 'score', target: 'n.md' }),
        '--text',
        'finding_detail',
        prose,
      ],
      { env: { ...process.env, CLAUDE_PLUGIN_DATA: root }, encoding: 'utf-8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const events = readEvents(root);
    assert.equal(events.length, 1);
    assert.equal(events[0].finding_detail, prose, 'prose must round-trip byte for byte');
    assert.equal(events[0].action, 'score');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stdin accepts several newline-separated events, the batching case', () => {
  // usage-provenance.md emits one line per note in a single call. The single
  // JSON.parse this file used to do threw on the second line and dropped the
  // whole batch, so this asserts the batch survives.
  const root = mkdtempSync(join(tmpdir(), 'll-prov-batch-'));
  try {
    const lines = [
      { agent: 'reflect', skill: 'reflect', action: 'note-usage', target: 'a.md', status: 'used' },
      {
        agent: 'reflect',
        skill: 'reflect',
        action: 'note-usage',
        target: 'b.md',
        status: 'ignored',
      },
      { agent: 'reflect', skill: 'reflect', action: 'note-usage', target: 'c.md', status: 'used' },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n');
    const result = spawnSync('node', [EMIT, '-'], {
      input: lines,
      env: { ...process.env, CLAUDE_PLUGIN_DATA: root },
      encoding: 'utf-8',
    });
    assert.equal(result.status, 0, result.stderr);
    const events = readEvents(root);
    assert.equal(events.length, 3, 'every batched line must be emitted, not just the first');
    assert.deepEqual(
      events.map((e) => e.target),
      ['a.md', 'b.md', 'c.md'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
