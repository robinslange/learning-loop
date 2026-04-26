import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const HOOK = join(import.meta.dirname, '..', 'hooks', 'post-read-retrieval.js');
const runId = randomBytes(8).toString('hex');
const PLUGIN_DATA = join(tmpdir(), `ll-test-plugin-data-readret-${runId}`);
const RETRIEVAL_DIR = join(PLUGIN_DATA, 'retrieval');

function run(payload) {
  return execFileSync('node', [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: { ...process.env, CLAUDE_PLUGIN_DATA: PLUGIN_DATA },
    timeout: 5000,
  });
}

function readRetrieval(prefix) {
  if (!existsSync(RETRIEVAL_DIR)) return [];
  const files = readdirSync(RETRIEVAL_DIR).filter(f => f.startsWith(`${prefix}-`) && f.endsWith('.jsonl'));
  const events = [];
  for (const f of files) {
    const lines = readFileSync(join(RETRIEVAL_DIR, f), 'utf-8').split('\n').filter(l => l.trim());
    for (const line of lines) events.push(JSON.parse(line));
  }
  return events;
}

describe('post-read-retrieval', () => {
  before(() => {
    mkdirSync(PLUGIN_DATA, { recursive: true });
  });

  beforeEach(() => {
    rmSync(RETRIEVAL_DIR, { recursive: true, force: true });
  });

  after(() => {
    rmSync(PLUGIN_DATA, { recursive: true, force: true });
  });

  it('logs a memory-read event for a Read of an auto-memory file', () => {
    const memFile = '/Users/somebody/.claude/projects/-Users-somebody-proj/memory/user_age.md';
    run({
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: memFile },
      tool_response: { success: true },
    });

    const events = readRetrieval('reads');
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'memory-read');
    assert.equal(events[0].file, 'user_age.md');
  });

  it('writes nothing for non-memory file reads', () => {
    run({
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/some/random/file.md' },
      tool_response: { success: true },
    });

    assert.equal(readRetrieval('reads').length, 0);
  });
});
