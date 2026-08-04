import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { webGuardDecision } from '../plugin/hooks/web-guard.js';
import { toCodexAgent } from '../plugin/scripts/codex/generate-agents.mjs';

const HARNESS = fileURLToPath(new URL('../plugin/scripts/lib/harness.mjs', import.meta.url));

// env.mjs snapshots process.env at import time, so each case needs its own process.
function resolveHarness(env) {
  return execFileSync(
    process.execPath,
    ['-e', `import(${JSON.stringify(HARNESS)}).then((m) => process.stdout.write(m.harness()))`],
    { env: { ...process.env, LL_HARNESS: '', PLUGIN_ROOT: '', ...env }, encoding: 'utf-8' },
  );
}

describe('harness detection', () => {
  it('defaults to claude-code when nothing marks the harness', () => {
    assert.equal(resolveHarness({}), 'claude-code');
  });

  it('reads codex from PLUGIN_ROOT, which only Codex sets', () => {
    assert.equal(resolveHarness({ PLUGIN_ROOT: '/some/plugin' }), 'codex');
  });

  it('lets an explicit LL_HARNESS win over the PLUGIN_ROOT inference', () => {
    assert.equal(
      resolveHarness({ PLUGIN_ROOT: '/some/plugin', LL_HARNESS: 'claude-code' }),
      'claude-code',
    );
    assert.equal(resolveHarness({ LL_HARNESS: 'codex' }), 'codex');
  });

  it('ignores an unrecognised LL_HARNESS rather than trusting it', () => {
    assert.equal(resolveHarness({ LL_HARNESS: 'nonsense' }), 'claude-code');
  });
});

describe('web guard on the Codex shell path', () => {
  const deny = (tool, input) => webGuardDecision(tool, input);

  it('still denies the Claude Code web tools', () => {
    assert.equal(deny('WebFetch', {}).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(deny('WebSearch', {}).hookSpecificOutput.permissionDecision, 'deny');
  });

  it('denies a shell fetch of a remote URL', () => {
    const d = deny('Bash', { command: 'curl -sL https://example.com/doc.md -o doc.md' });
    assert.equal(d.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(d.hookSpecificOutput.permissionDecisionReason, /https:\/\/example\.com/);
    assert.match(d.hookSpecificOutput.permissionDecisionReason, /source-gateway/);
  });

  it('denies a fetcher hidden mid-pipeline', () => {
    assert.ok(deny('Bash', { command: 'echo hi && wget https://evil.test/x' }));
  });

  it('allows a shell fetch of the local model', () => {
    assert.equal(deny('Bash', { command: 'curl http://localhost:11434/api/tags' }), null);
    assert.equal(deny('Bash', { command: 'curl -s http://127.0.0.1:8080/health' }), null);
  });

  it('allows a fetcher invoked without a URL', () => {
    assert.equal(deny('Bash', { command: 'curl --version' }), null);
  });

  it('allows an ordinary shell command that merely mentions a URL', () => {
    assert.equal(deny('Bash', { command: 'echo "see https://example.com"' }), null);
  });

  it('does not match a word that merely contains a fetcher name', () => {
    assert.equal(deny('Bash', { command: 'node scripts/curly.mjs https://example.com' }), null);
  });
});

describe('Codex agent projection', () => {
  const source = [
    '---',
    'name: note-writer',
    'description: Writes notes.',
    'model: sonnet',
    'effort: xhigh',
    'tools: Read, Grep, Write',
    '---',
    '',
    '# Note writer',
    '',
    'Write the note.',
  ].join('\n');

  it('carries the three required Codex fields', () => {
    const { name, toml } = toCodexAgent(source, 'fallback');
    assert.equal(name, 'learning-loop-note-writer');
    assert.match(toml, /^name = "learning-loop-note-writer"$/m);
    assert.match(toml, /^description = "Writes notes\."$/m);
    assert.match(toml, /^developer_instructions = """$/m);
    assert.match(toml, /Write the note\./);
  });

  it('maps the model alias and carries reasoning effort', () => {
    const { toml } = toCodexAgent(source, 'fallback');
    assert.match(toml, /^model = "gpt-5\.6"$/m);
    assert.match(toml, /^model_reasoning_effort = "xhigh"$/m);
  });

  it('sandboxes an agent that never writes, and only that one', () => {
    const readOnly = source.replace('tools: Read, Grep, Write', 'tools: Read, Grep');
    assert.match(toCodexAgent(readOnly, 'x').toml, /^sandbox_mode = "read-only"$/m);
    assert.doesNotMatch(toCodexAgent(source, 'x').toml, /sandbox_mode/);
  });

  it('falls back to the filename when frontmatter omits the name', () => {
    assert.equal(
      toCodexAgent('no frontmatter here', 'gap-analyser').name,
      'learning-loop-gap-analyser',
    );
  });

  it('omits model keys it cannot map rather than emitting a bad slug', () => {
    const odd = source
      .replace('model: sonnet', 'model: gpt-9')
      .replace('effort: xhigh', 'effort: turbo');
    const { toml } = toCodexAgent(odd, 'x');
    assert.doesNotMatch(toml, /^model = /m);
    assert.doesNotMatch(toml, /model_reasoning_effort/);
  });

  it('escapes a body that would otherwise break the TOML string', () => {
    const nasty = source.replace('Write the note.', 'Use """ and a \\ backslash.');
    const { toml } = toCodexAgent(nasty, 'x');
    assert.match(toml, /\\"\\"\\"/);
    assert.match(toml, /\\\\ backslash/);
  });
});

describe('Codex plugin manifest', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../plugin/.codex-plugin/plugin.json', import.meta.url), 'utf-8'),
  );
  const claude = JSON.parse(
    readFileSync(new URL('../plugin/.claude-plugin/plugin.json', import.meta.url), 'utf-8'),
  );

  it('stays in version lockstep with the Claude Code manifest', () => {
    assert.equal(manifest.version, claude.version);
    assert.equal(manifest.name, claude.name);
  });

  it('points at the shared skills and both hook files', () => {
    assert.equal(manifest.skills, './skills/');
    assert.deepEqual(manifest.hooks, ['./hooks/hooks.json', './hooks/hooks.codex.json']);
  });
});
