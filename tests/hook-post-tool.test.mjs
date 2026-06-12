// tests/hook-post-tool.test.mjs
// Characterisation tests for hooks/post-tool.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runHook } from './helpers/hook-runner.mjs';

const HOOK = new URL('../plugin/hooks/post-tool.js', import.meta.url).pathname;
const VAULT = new URL('./fixtures/vault-small', import.meta.url).pathname;

// Read all provenance JSONL lines from pluginData.
function readProvenance(pluginDataDir) {
  const dir = join(pluginDataDir, 'provenance');
  if (!existsSync(dir)) return [];
  const lines = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
    const raw = readFileSync(join(dir, f), 'utf8');
    for (const line of raw.split('\n').filter((l) => l.trim())) {
      lines.push(JSON.parse(line));
    }
  }
  return lines;
}

// Read all hook-error JSONL lines from pluginData.
function readHookErrors(pluginDataDir) {
  if (!existsSync(pluginDataDir)) return [];
  const lines = [];
  for (const f of readdirSync(pluginDataDir).filter(
    (n) => n.startsWith('hook-errors-') && n.endsWith('.jsonl'),
  )) {
    const raw = readFileSync(join(pluginDataDir, f), 'utf8');
    for (const line of raw.split('\n').filter((l) => l.trim())) {
      lines.push(JSON.parse(line));
    }
  }
  return lines;
}

test('post-tool Write on vault note: provenance JSONL written, no hook-errors file', () => {
  const notePath = join(VAULT, '0-inbox', 'new-note.md');
  const r = runHook(HOOK, {
    stdin: {
      tool_name: 'Write',
      tool_input: { file_path: notePath, content: '---\ntags: [test]\n---\nTest body.' },
      tool_response: { success: true },
    },
    env: { VAULT_PATH: VAULT },
  });
  try {
    assert.equal(r.exitCode, 0, `unexpected exit code: ${r.exitCode}\nstderr: ${r.stderr}`);
    assert.equal(r.stdout.trim(), '', 'post-tool should produce no stdout');

    const events = readProvenance(r.pluginDataDir);
    assert.ok(events.length > 0, 'at least one provenance event should be written');

    const writeEvent = events.find((e) => e.action === 'vault-write');
    assert.ok(writeEvent, `expected vault-write event; got: ${JSON.stringify(events)}`);
    assert.match(writeEvent.target, /0-inbox\/new-note\.md/);
    assert.equal(writeEvent.folder, 'inbox');

    const errors = readHookErrors(r.pluginDataDir);
    assert.deepEqual(errors, [], `unexpected hook errors: ${JSON.stringify(errors)}`);
  } finally {
    r.cleanup();
  }
});

test('post-tool Read tool: no provenance vault-write event', () => {
  const notePath = join(VAULT, '3-permanent', 'sleep.md');
  const r = runHook(HOOK, {
    stdin: {
      tool_name: 'Read',
      tool_input: { file_path: notePath },
      tool_response: { content: '---\ntags: [sleep]\n---\n' },
    },
    env: { VAULT_PATH: VAULT },
  });
  try {
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout.trim(), '');

    const events = readProvenance(r.pluginDataDir);
    const writeEvents = events.filter(
      (e) => e.action === 'vault-write' || e.action === 'vault-edit',
    );
    assert.deepEqual(
      writeEvents,
      [],
      `Read should not produce vault-write events; got: ${JSON.stringify(writeEvents)}`,
    );
  } finally {
    r.cleanup();
  }
});

// Regression: cheap load-bearing modules (provenance, reflect-track) must run
// BEFORE the expensive enrichment modules (autolink, edge-infer), so an outer
// hooks.json SIGKILL mid-loop only ever drops enrichment. Autolink must stay
// ahead of edge-infer: autolink populates ctx.autolinkCandidates (edge-infer's
// NLI input), and edge-infer's Edit-path disk read — plus replayed runs, which
// snapshot disk into input.content — see autolink's appended links. (Live
// Write-path edge-infer reads input.content, not disk.)
test('post-tool module order: load-bearing before enrichment, autolink before edge-infer', () => {
  const src = readFileSync(new URL('../plugin/hooks/post-tool.js', import.meta.url), 'utf8');
  const m = src.match(/const modules = isWriteEdit\s*\?\s*\[([^\]]+)\]/);
  assert.ok(m, 'post-tool.js must declare the isWriteEdit module array');
  const order = m[1].split(',').map((s) => s.trim());
  const idx = (name) => order.indexOf(name);
  for (const name of ['runProvenance', 'runReflectTrack', 'runAutolink', 'runEdgeInfer']) {
    assert.ok(idx(name) >= 0, `${name} missing from the write/edit module chain`);
  }
  assert.ok(idx('runProvenance') < idx('runAutolink'), 'provenance must run before autolink');
  assert.ok(idx('runReflectTrack') < idx('runAutolink'), 'reflect-track must run before autolink');
  assert.ok(idx('runAutolink') < idx('runEdgeInfer'), 'autolink must run before edge-infer');
});

test('post-tool malformed stdin: exits 0, nothing written', () => {
  const r = runHook(HOOK, {
    stdin: 'this is not valid json {{{',
    env: { VAULT_PATH: VAULT },
  });
  try {
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout.trim(), '');

    const events = readProvenance(r.pluginDataDir);
    assert.deepEqual(events, [], `malformed stdin should produce no provenance events`);

    const errors = readHookErrors(r.pluginDataDir);
    assert.deepEqual(errors, [], `malformed stdin should produce no hook errors`);
  } finally {
    r.cleanup();
  }
});
