// tests/hooks-disabled-config.test.mjs
// Per-component hook disable. Before this, the only options were a full
// uninstall, hand-editing hooks.json inside the plugin cache (overwritten on
// update), or a global `disableAllHooks` that silences every plugin.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const HOOK = join(import.meta.dirname, '..', 'plugin', 'hooks', 'post-search-tracking.js');
const PLUGIN_DATA = join(tmpdir(), `ll-hooks-disabled-${randomBytes(6).toString('hex')}`);
const RETRIEVAL_DIR = join(PLUGIN_DATA, 'retrieval');

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

  it('exits 0 so a disabled PreToolUse hook never blocks the tool', () => {
    writeConfig({ hooks: { disabled: ['post-search-tracking'] } });
    assert.equal(runSearchHook(), '', 'a disabled hook emits no stdout');
  });

  it('covers every shipped hook, not just the ones behind runHook()', () => {
    const hooksDir = join(import.meta.dirname, '..', 'plugin', 'hooks');
    const hooks = readdirSync(hooksDir).filter((f) => f.endsWith('.js'));
    assert.ok(hooks.length >= 8, `expected the full hook set, saw ${hooks.length}`);
    for (const file of hooks) {
      const name = file.replace(/\.js$/, '');
      writeConfig({ hooks: { disabled: [name] } });
      const out = execFileSync('node', [join(hooksDir, file)], {
        input: JSON.stringify({ session_id: 'disabled-sweep', tool_name: 'Write', tool_input: {} }),
        encoding: 'utf-8',
        env: { ...process.env, CLAUDE_PLUGIN_DATA: PLUGIN_DATA },
        timeout: 12000,
      });
      assert.equal(out, '', `${name} still emitted output while disabled`);
    }
  });

  it('ignores a malformed disabled value instead of failing shut', () => {
    writeConfig({ hooks: { disabled: 'post-search-tracking' } });
    runSearchHook();
    assert.equal(retrievalFileCount(), 1, 'a non-array disabled key disables nothing');
  });
});
