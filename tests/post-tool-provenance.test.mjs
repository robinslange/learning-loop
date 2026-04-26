import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const HOOK = join(import.meta.dirname, '..', 'hooks', 'post-tool-provenance.js');
const runId = randomBytes(8).toString('hex');
const VAULT = join(tmpdir(), `ll-test-vault-prov-${runId}`);
const PLUGIN_DATA = join(tmpdir(), `ll-test-plugin-data-prov-${runId}`);
const PROVENANCE_DIR = join(PLUGIN_DATA, 'provenance');

function run(payload) {
  return execFileSync('node', [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: { ...process.env, VAULT_PATH: VAULT, CLAUDE_PLUGIN_DATA: PLUGIN_DATA },
    timeout: 5000,
  });
}

function readProvenanceEvents() {
  if (!existsSync(PROVENANCE_DIR)) return [];
  const files = readdirSync(PROVENANCE_DIR).filter(f => f.startsWith('events-') && f.endsWith('.jsonl'));
  const events = [];
  for (const f of files) {
    const lines = readFileSync(join(PROVENANCE_DIR, f), 'utf-8').split('\n').filter(l => l.trim());
    for (const line of lines) events.push(JSON.parse(line));
  }
  return events;
}

describe('post-tool-provenance', () => {
  before(() => {
    mkdirSync(join(VAULT, '3-permanent'), { recursive: true });
    mkdirSync(PLUGIN_DATA, { recursive: true });
  });

  beforeEach(() => {
    rmSync(PROVENANCE_DIR, { recursive: true, force: true });
  });

  after(() => {
    rmSync(VAULT, { recursive: true, force: true });
    rmSync(PLUGIN_DATA, { recursive: true, force: true });
  });

  it('emits a vault-write event for a Write tool inside the vault', () => {
    const filePath = join(VAULT, '3-permanent', 'foo.md');
    run({
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: {
        file_path: filePath,
        content: '---\ntags: [neuroscience, vault]\n---\n# Foo\n',
      },
      tool_response: { filePath, success: true },
    });

    const events = readProvenanceEvents();
    assert.equal(events.length, 1, 'one provenance event expected');
    const e = events[0];
    assert.equal(e.action, 'vault-write');
    assert.equal(e.target, '3-permanent/foo.md');
    assert.equal(e.folder, 'permanent');
    assert.deepEqual(e.tags, ['neuroscience', 'vault']);
    assert.ok(e.ts, 'event must have a timestamp');
    assert.equal(e.source, 'hook');
  });

  it('emits a skill-invoke event for a Skill tool call', () => {
    run({
      hook_event_name: 'PostToolUse',
      tool_name: 'Skill',
      tool_input: { skill: 'learning-loop:reflect', args: '' },
      tool_response: { success: true },
    });

    const events = readProvenanceEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].action, 'skill-invoke');
    assert.equal(events[0].skill, 'learning-loop:reflect');
  });

  it('writes nothing for non-vault file writes', () => {
    const outsidePath = join(tmpdir(), `outside-${runId}.md`);
    run({
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: { file_path: outsidePath, content: '# not in vault' },
      tool_response: { filePath: outsidePath, success: true },
    });

    assert.equal(readProvenanceEvents().length, 0);
  });
});
