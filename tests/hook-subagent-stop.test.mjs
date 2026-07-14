// tests/hook-subagent-stop.test.mjs
// Characterisation tests for hooks/subagent-stop.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHook } from './helpers/hook-runner.mjs';

const HOOK = fileURLToPath(new URL('../plugin/hooks/subagent-stop.js', import.meta.url));

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

test('subagent-stop: emits agent-result provenance event with session_id', () => {
  const r = runHook(HOOK, {
    stdin: {
      session_id: 'test-subagent-stop',
      transcript_path: '/tmp/fake-transcript.jsonl',
      hook_event_name: 'SubagentStop',
      stop_hook_active: false,
    },
  });
  try {
    assert.equal(r.exitCode, 0, `unexpected exit code: ${r.exitCode}\nstderr: ${r.stderr}`);

    const events = readProvenance(r.pluginDataDir);
    const resultEvent = events.find((e) => e.action === 'agent-result');
    assert.ok(resultEvent, `expected agent-result event; got: ${JSON.stringify(events)}`);
    assert.ok(resultEvent.session_id, 'event must carry a session_id');
  } finally {
    r.cleanup();
  }
});
