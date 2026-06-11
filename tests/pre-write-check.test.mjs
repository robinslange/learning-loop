import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runHook } from './helpers/hook-runner.mjs';
import { VAULT_DIRS, TITLE_INDEX_EXTRA_DIRS } from '../hooks/lib/snapshot.mjs';

const HOOK = new URL('../hooks/pre-write-check.js', import.meta.url).pathname;
let VAULT;
let NON_VAULT;

// Run the hook through the shared hermetic harness and parse its single
// JSON stdout payload (null when the hook stayed silent).
function run(toolName, filePath, content) {
  const r = runHook(HOOK, {
    stdin: {
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      tool_input: { file_path: filePath, content },
    },
    env: { VAULT_PATH: VAULT },
  });
  try {
    assert.equal(r.signal, null, `hook killed by ${r.signal}; stderr: ${r.stderr}`);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.ok(!r.stderr.includes('"level":"error"'), `hook logged an error: ${r.stderr}`);
    const out = r.stdout.trim();
    return out ? JSON.parse(out) : null;
  } finally {
    r.cleanup();
  }
}

describe('pre-write-check', () => {
  before(() => {
    VAULT = mkdtempSync(join(tmpdir(), 'll-pwc-vault-'));
    NON_VAULT = mkdtempSync(join(tmpdir(), 'll-pwc-other-'));
    // Every dir the snapshot rebuild scans must exist, or the hook logs a
    // readdir error that trips run()'s clean-stderr assertion.
    for (const dir of [...VAULT_DIRS, ...TITLE_INDEX_EXTRA_DIRS, '_system']) {
      mkdirSync(join(VAULT, dir), { recursive: true });
    }
    writeFileSync(join(VAULT, '3-permanent', 'existing-note.md'), '---\ntitle: existing note\n---\n');
    writeFileSync(join(VAULT, '6-writing', 'the-loud-room.md'), '---\ntitle: the loud room\n---\n');
  });

  after(() => {
    rmSync(VAULT, { recursive: true, force: true });
    rmSync(NON_VAULT, { recursive: true, force: true });
  });

  it('ignores non-vault writes', () => {
    const result = run('Write', join(NON_VAULT, 'file.md'), '---\ntags: [a, a]\n---\n');
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

  it('resolves bare-basename wikilinks to notes living in 6-writing/', () => {
    const content = '---\ntags: [sleep]\n---\nSee [[the-loud-room]].';
    const result = run('Write', join(VAULT, '0-inbox', 'test.md'), content);
    assert.equal(result, null);
  });

  it('resolves subdir-prefixed wikilinks like [[6-writing/the-loud-room]]', () => {
    const content = '---\ntags: [sleep]\n---\nSee [[6-writing/the-loud-room]].';
    const result = run('Write', join(VAULT, '0-inbox', 'test.md'), content);
    assert.equal(result, null);
  });

  it('resolves subdir-prefixed wikilinks like [[3-permanent/existing-note]]', () => {
    const content = '---\ntags: [sleep]\n---\nSee [[3-permanent/existing-note]].';
    const result = run('Write', join(VAULT, '0-inbox', 'test.md'), content);
    assert.equal(result, null);
  });

  it('denies an em-dash in body prose, naming the line', () => {
    const content = '---\ntags: [sleep]\n---\nThe rule is policy — or it is aspiration.';
    const result = run('Write', join(VAULT, '0-inbox', 'test.md'), content);
    assert.ok(result);
    assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(result.hookSpecificOutput.permissionDecisionReason, /em.?dash|en.?dash|dash/i);
    assert.match(result.hookSpecificOutput.permissionDecisionReason, /aspiration/);
  });

  it('denies an en-dash in body prose', () => {
    const content = '---\ntags: [sleep]\n---\nThe range is 3–5 notes per day.';
    const result = run('Write', join(VAULT, '0-inbox', 'test.md'), content);
    assert.ok(result);
    assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
  });

  // permissionDecision must not be 'deny' whether the hook emitted output or
  // not — optional chaining over null gives undefined, which satisfies
  // notEqual.
  it('allows an em-dash on a Source: line', () => {
    const content = '---\ntags: [sleep]\n---\nClean body.\n\nSource: example.com — pulled after second reading.';
    const result = run('Write', join(VAULT, '0-inbox', 'test.md'), content);
    assert.notEqual(result?.hookSpecificOutput?.permissionDecision, 'deny');
  });

  it('allows an em-dash on a Related: line', () => {
    const content = '---\ntags: [sleep]\n---\nClean body.\n\nRelated: [[existing-note]] — the same shape at the data layer.';
    const result = run('Write', join(VAULT, '0-inbox', 'test.md'), content);
    assert.notEqual(result?.hookSpecificOutput?.permissionDecision, 'deny');
  });

  it('allows an em-dash inside frontmatter only', () => {
    const content = '---\ntags: [sleep]\nsource: 2026-05-29 vault sweep — span bug caught in preview\n---\nClean body with no dashes.';
    const result = run('Write', join(VAULT, '0-inbox', 'test.md'), content);
    assert.equal(result, null);
  });

  it('denies on duplicate tags before checking em-dashes (tags win)', () => {
    const content = '---\ntags: [sleep, sleep]\n---\nBody with an em-dash — here.';
    const result = run('Write', join(VAULT, '0-inbox', 'test.md'), content);
    assert.ok(result);
    assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(result.hookSpecificOutput.permissionDecisionReason, /sleep/);
  });

  // Vault convention: frontmatter source: is an origin tag and a body
  // Sources: line is a citation — together they are neither a leak nor a
  // violation, so the hook must produce no output at all.
  it('stays silent on frontmatter source: plus a body Sources: line', () => {
    const content = '---\ntags: [test]\nsource: https://example.com/paper\ndate: 2026-05-21\n---\n\n# Test Note\n\nThe claim happens.\n\nSources: pulled from example.com after second reading.\n';
    const result = run('Write', join(VAULT, '0-inbox', 'test-conventions.md'), content);
    assert.equal(result, null);
  });

  it('stays silent on a body Sources: line with no frontmatter source field', () => {
    const content = '---\ntags: [test]\n---\n\n# Test Note\n\nSources: a blog post.\n';
    const result = run('Write', join(VAULT, '0-inbox', 'test-conventions-2.md'), content);
    assert.equal(result, null);
  });
});
