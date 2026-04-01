import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const HOOK = join(import.meta.dirname, '..', 'hooks', 'pre-write-check.js');
const VAULT = '/tmp/ll-test-vault';

function run(toolName, filePath, content) {
  const input = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: { file_path: filePath, content },
  });
  const out = execFileSync('node', [HOOK], {
    input,
    encoding: 'utf-8',
    env: { ...process.env, VAULT_PATH: VAULT },
    timeout: 5000,
  });
  return out.trim() ? JSON.parse(out.trim()) : null;
}

describe('pre-write-check', () => {
  before(() => {
    mkdirSync(join(VAULT, '0-inbox'), { recursive: true });
    mkdirSync(join(VAULT, '3-permanent'), { recursive: true });
    mkdirSync(join(VAULT, '_system'), { recursive: true });
    writeFileSync(join(VAULT, '3-permanent', 'existing-note.md'), '---\ntitle: existing note\n---\n');
  });

  after(() => {
    rmSync(VAULT, { recursive: true, force: true });
  });

  it('ignores non-vault writes', () => {
    const result = run('Write', '/tmp/other/file.md', '---\ntags: [a, a]\n---\n');
    assert.equal(result, null);
  });

  it('ignores non-Write tools', () => {
    const result = run('Read', join(VAULT, '0-inbox', 'test.md'), '---\ntags: [a, a]\n---\n');
    assert.equal(result, null);
  });

  it('ignores non-.md files in vault', () => {
    const result = run('Write', join(VAULT, '0-inbox', 'test.txt'), '---\ntags: [a, a]\n---\n');
    assert.equal(result, null);
  });

  it('ignores _system/ paths', () => {
    const result = run('Write', join(VAULT, '_system', 'config.md'), '---\ntags: [a, a]\n---\n');
    assert.equal(result, null);
  });

  it('denies duplicate tags (inline format)', () => {
    const content = '---\ntags: [sleep, circadian, sleep]\n---\nBody text.';
    const result = run('Write', join(VAULT, '0-inbox', 'test.md'), content);
    assert.ok(result);
    assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(result.hookSpecificOutput.permissionDecisionReason, /sleep/);
  });

  it('denies duplicate tags (block format)', () => {
    const content = '---\ntags:\n  - sleep\n  - circadian\n  - sleep\n---\nBody text.';
    const result = run('Write', join(VAULT, '0-inbox', 'test.md'), content);
    assert.ok(result);
    assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(result.hookSpecificOutput.permissionDecisionReason, /sleep/);
  });

  it('allows clean notes with no issues', () => {
    const content = '---\ntags: [sleep, circadian]\n---\nBody with [[existing-note]].';
    const result = run('Write', join(VAULT, '0-inbox', 'test.md'), content);
    assert.equal(result, null);
  });

  it('allows notes with no frontmatter', () => {
    const content = 'Just a plain note with no frontmatter.';
    const result = run('Write', join(VAULT, '0-inbox', 'test.md'), content);
    assert.equal(result, null);
  });

  it('warns on broken wikilinks (additionalContext, NOT deny)', () => {
    const content = '---\ntags: [sleep]\n---\nSee [[nonexistent-note]] and [[also-missing]].';
    const result = run('Write', join(VAULT, '0-inbox', 'test.md'), content);
    assert.ok(result);
    assert.equal(result.hookSpecificOutput.permissionDecision, undefined);
    assert.ok(result.hookSpecificOutput.additionalContext);
    assert.match(result.hookSpecificOutput.additionalContext, /nonexistent-note/);
    assert.match(result.hookSpecificOutput.additionalContext, /also-missing/);
  });
});
