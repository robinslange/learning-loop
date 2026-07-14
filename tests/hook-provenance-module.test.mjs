// tests/hook-provenance-module.test.mjs
// Characterisation tests for hooks/modules/provenance.mjs and its hooks.json wiring.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHook } from './helpers/hook-runner.mjs';

const ROOT = join(import.meta.dirname, '..', 'plugin', 'hooks');
const HOOK = fileURLToPath(new URL('../plugin/hooks/post-tool.js', import.meta.url));

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

test('provenance module and hooks.json target the real subagent tool name Task', () => {
  const hooksJson = readFileSync(join(ROOT, 'hooks.json'), 'utf8');
  const provenance = readFileSync(join(ROOT, 'modules', 'provenance.mjs'), 'utf8');
  assert.match(hooksJson, /Task/, 'PostToolUse matcher must include Task');
  assert.doesNotMatch(hooksJson, /\|Agent\|/, 'stale Agent matcher must be gone');
  assert.match(provenance, /===\s*'Task'/, 'provenance module must check for Task');
});

test('post-tool Task tool: emits agent-spawn provenance event', () => {
  const r = runHook(HOOK, {
    stdin: {
      tool_name: 'Task',
      tool_input: { subagent_type: 'x', description: 'y' },
      tool_response: { success: true },
    },
  });
  try {
    assert.equal(r.exitCode, 0, `unexpected exit code: ${r.exitCode}\nstderr: ${r.stderr}`);

    const events = readProvenance(r.pluginDataDir);
    const spawnEvent = events.find((e) => e.action === 'agent-spawn');
    assert.ok(spawnEvent, `expected agent-spawn event; got: ${JSON.stringify(events)}`);
    assert.equal(spawnEvent.agent, 'x');
    assert.equal(spawnEvent.description, 'y');
  } finally {
    r.cleanup();
  }
});
