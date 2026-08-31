// tests/hooks-disabled-config.test.mjs
// Per-component hook disable. Before this, the only options were a full
// uninstall, hand-editing hooks.json inside the plugin cache (overwritten on
// update), or a global `disableAllHooks` that silences every plugin.
//
// The sweep below drives each hook with an input it ACTUALLY ACTS ON and
// asserts the observable is present when enabled and absent when disabled. An
// earlier version fed every hook a payload none of them worked on and asserted
// empty stdout, which was true before the feature existed — it pinned one hook
// of nine and its name claimed all nine.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runHook } from './helpers/hook-runner.mjs';

const HOOKS_DIR = fileURLToPath(new URL('../plugin/hooks', import.meta.url));
const VAULT = fileURLToPath(new URL('./fixtures/vault-small', import.meta.url));
const HOOK = join(HOOKS_DIR, 'post-search-tracking.js');
const PLUGIN_DATA = join(tmpdir(), `ll-hooks-disabled-${randomBytes(6).toString('hex')}`);
const RETRIEVAL_DIR = join(PLUGIN_DATA, 'retrieval');

const NOTE = '---\ntags: [x]\ndate: 2026-08-03\nsource: synthesis\n---\nBody.';
const PROMPT = 'how do I configure ollama for the vault';

// Each hook, an input it does real work on, and the trace that work leaves.
// `file` is a path prefix under plugin-data; `stdout` means a non-empty payload.
const SWEEP = [
  { name: 'session-start', stdin: () => ({ session_id: 's' }), stdout: true },
  {
    name: 'session-label',
    stdin: (sb) => ({
      session_id: 's',
      prompt: PROMPT,
      cwd: '/tmp',
      transcript_path: join(sb, 't.jsonl'),
    }),
    file: 'retrieval/shadow-injection',
  },
  {
    name: 'pre-write-check',
    stdin: () => ({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: join(VAULT, '0-inbox', 'x.md'), content: 'no frontmatter' },
    }),
    stdout: true,
  },
  {
    name: 'web-guard',
    stdin: () => ({
      hook_event_name: 'PreToolUse',
      tool_name: 'WebFetch',
      tool_input: { url: 'https://example.com/x' },
    }),
    stdout: true,
  },
  {
    name: 'post-tool',
    stdin: () => ({
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: { file_path: join(VAULT, '0-inbox', 'x.md'), content: NOTE },
      tool_response: {},
    }),
    file: 'provenance/events',
  },
  {
    name: 'post-read-retrieval',
    stdin: (sb) => ({
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: join(sb, '.claude', 'projects', 'p', 'memory', 'MEMORY.md') },
      tool_response: {},
    }),
    file: 'retrieval/reads',
  },
  {
    name: 'post-search-tracking',
    stdin: () => ({
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__plugin_episodic-memory_episodic-memory__search',
      tool_input: { query: 'ollama' },
      tool_response: { results: [] },
    }),
    file: 'retrieval/episodic-queries',
  },
  {
    name: 'stop-nudge',
    stdin: (sb) => ({ session_id: 's', transcript_path: join(sb, 'big.jsonl') }),
    stdout: true,
  },
  {
    name: 'subagent-stop',
    stdin: (sb) => ({ session_id: 's', transcript_path: join(sb, 't.jsonl') }),
    file: 'provenance/events',
  },
];

function seedSandbox(disabledNames) {
  return (pd, sb) => {
    writeFileSync(
      join(pd, 'config.json'),
      JSON.stringify(disabledNames ? { hooks: { disabled: disabledNames } } : {}),
    );
    writeFileSync(
      join(pd, 'update-check.json'),
      JSON.stringify({ checked_at: new Date().toISOString(), latest: null }),
    );
    const md = join(sb, '.claude', 'projects', 'p', 'memory');
    mkdirSync(md, { recursive: true });
    writeFileSync(join(md, 'MEMORY.md'), '- [a.md](a.md) — x\n');
    const line =
      JSON.stringify({ type: 'user', message: { role: 'user', content: PROMPT } }) + '\n';
    writeFileSync(join(sb, 't.jsonl'), line);
    writeFileSync(join(sb, 'big.jsonl'), line.repeat(250));
  };
}

function traceOf(spec, disabledNames) {
  const r = runHook(join(HOOKS_DIR, `${spec.name}.js`), {
    stdin: (sb) => spec.stdin(sb),
    env: { VAULT_PATH: VAULT, CLAUDE_PROJECT_DIR: '/tmp/ll-sweep-proj' },
    seed: seedSandbox(disabledNames),
  });
  try {
    assert.equal(r.exitCode, 0, `${spec.name} exited ${r.exitCode}: ${r.stderr}`);
    if (spec.stdout) return r.stdout.trim().length > 0;
    const [dir, prefix] = spec.file.split('/');
    const full = join(r.pluginDataDir, dir);
    return existsSync(full) && readdirSync(full).some((f) => f.startsWith(prefix));
  } finally {
    r.cleanup();
  }
}

function writeConfig(config) {
  writeFileSync(join(PLUGIN_DATA, 'config.json'), JSON.stringify(config));
}

function runSearchHook() {
  return execFileSync('node', [HOOK], {
    input: JSON.stringify({
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__plugin_episodic-memory_episodic-memory__search',
      tool_input: { query: 'anything' },
      tool_response: { results: [] },
    }),
    encoding: 'utf-8',
    env: { ...process.env, CLAUDE_PLUGIN_DATA: PLUGIN_DATA },
    timeout: 5000,
  });
}

function retrievalFileCount() {
  if (!existsSync(RETRIEVAL_DIR)) return 0;
  return readdirSync(RETRIEVAL_DIR).filter((f) => f.startsWith('episodic-queries-')).length;
}

describe('hooks.disabled', () => {
  before(() => mkdirSync(PLUGIN_DATA, { recursive: true }));
  beforeEach(() => rmSync(RETRIEVAL_DIR, { recursive: true, force: true }));
  after(() => rmSync(PLUGIN_DATA, { recursive: true, force: true }));

  it('runs the hook when its name is not listed', () => {
    writeConfig({ hooks: { disabled: ['session-label'] } });
    runSearchHook();
    assert.equal(retrievalFileCount(), 1, 'an unlisted hook still runs');
  });

  it('silences a hook named in hooks.disabled', () => {
    writeConfig({ hooks: { disabled: ['post-search-tracking'] } });
    runSearchHook();
    assert.equal(retrievalFileCount(), 0, 'a disabled hook must write nothing');
  });

  it('ignores a malformed disabled value instead of failing shut', () => {
    writeConfig({ hooks: { disabled: 'post-search-tracking' } });
    runSearchHook();
    assert.equal(retrievalFileCount(), 1, 'a non-array disabled key disables nothing');
  });

  it('lets a disabled PreToolUse hook allow a write the enabled gate denies', () => {
    const stdin = SWEEP.find((s) => s.name === 'pre-write-check').stdin;
    const run = (disabled) => {
      const r = runHook(join(HOOKS_DIR, 'pre-write-check.js'), {
        stdin: (sb) => stdin(sb),
        env: { VAULT_PATH: VAULT },
        seed: seedSandbox(disabled),
      });
      try {
        assert.equal(r.exitCode, 0, r.stderr);
        return r.stdout.trim() ? JSON.parse(r.stdout.trim()) : null;
      } finally {
        r.cleanup();
      }
    };

    const enabled = run(null);
    assert.equal(
      enabled?.hookSpecificOutput?.permissionDecision,
      'deny',
      'the enabled gate must actually deny this write, or the disabled case proves nothing',
    );
    assert.equal(run(['pre-write-check']), null, 'a disabled gate must not deny');
  });

  describe('covers every shipped hook, not just the ones behind runHook()', () => {
    it('drives all nine, and the roster matches what ships', () => {
      const shipped = readdirSync(HOOKS_DIR)
        .filter((f) => f.endsWith('.js'))
        .map((f) => f.replace(/\.js$/, ''))
        .sort();
      assert.deepEqual(
        SWEEP.map((s) => s.name).sort(),
        shipped,
        'every shipped hook needs a sweep entry with a real observable',
      );
    });

    for (const spec of SWEEP) {
      it(`${spec.name}: does observable work enabled, none disabled`, { timeout: 20000 }, () => {
        assert.equal(
          traceOf(spec, null),
          true,
          `${spec.name} did no observable work even when ENABLED — this input cannot discriminate`,
        );
        assert.equal(traceOf(spec, [spec.name]), false, `${spec.name} still worked while disabled`);
      });
    }
  });
});
