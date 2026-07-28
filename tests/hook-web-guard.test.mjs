import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { runHook } from './helpers/hook-runner.mjs';
import { webGuardDecision } from '../plugin/hooks/web-guard.js';

const HOOK = fileURLToPath(new URL('../plugin/hooks/web-guard.js', import.meta.url));

function run(toolName) {
  const r = runHook(HOOK, {
    stdin: { hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: {} },
  });
  try {
    assert.equal(r.signal, null, `hook killed by ${r.signal}; stderr: ${r.stderr}`);
    assert.equal(r.exitCode, 0, r.stderr);
    const out = r.stdout.trim();
    return out ? JSON.parse(out) : null;
  } finally {
    r.cleanup();
  }
}

describe('webGuardDecision (pure)', () => {
  it('denies WebSearch and WebFetch, naming the gateway', () => {
    for (const t of ['WebSearch', 'WebFetch']) {
      const d = webGuardDecision(t);
      assert.equal(d.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(d.hookSpecificOutput.permissionDecisionReason, /source-gateway/);
    }
  });
  it('passes through other tools (null)', () => {
    for (const t of ['Read', 'Bash', 'Write', 'Edit', undefined]) {
      assert.equal(webGuardDecision(t), null);
    }
  });
});

describe('web-guard hook (process boundary)', () => {
  it('emits a deny decision for WebSearch', () => {
    const out = run('WebSearch');
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /source-gateway/);
  });
  it('emits a deny decision for WebFetch', () => {
    const out = run('WebFetch');
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  });
  it('stays silent (pass-through) for Read', () => {
    assert.equal(run('Read'), null);
  });
});
