import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const HOOK = join(import.meta.dirname, '..', 'plugin', 'hooks', 'post-search-tracking.js');
const runId = randomBytes(8).toString('hex');
const PLUGIN_DATA = join(tmpdir(), `ll-test-plugin-data-search-${runId}`);
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

describe('post-search-tracking', () => {
  before(() => {
    mkdirSync(PLUGIN_DATA, { recursive: true });
  });

  beforeEach(() => {
    rmSync(RETRIEVAL_DIR, { recursive: true, force: true });
  });

  after(() => {
    rmSync(PLUGIN_DATA, { recursive: true, force: true });
  });

  it('logs an episodic-search event for a payload with a query', () => {
    run({
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__plugin_episodic-memory_episodic-memory__search',
      tool_input: { query: 'how do I configure ollama' },
      tool_response: { results: [] },
    });

    const events = readRetrieval('episodic-queries');
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'episodic-search');
    assert.equal(events[0].query, 'how do I configure ollama');
    assert.equal(events[0].tool, 'mcp__plugin_episodic-memory_episodic-memory__search');
    assert.ok(events[0].ts);
  });

  it('joins array-form queries into a single string', () => {
    run({
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__plugin_episodic-memory_episodic-memory__search',
      tool_input: { query: ['vault search', 'ranking'] },
      tool_response: { results: [] },
    });

    const events = readRetrieval('episodic-queries');
    assert.equal(events.length, 1);
    assert.equal(events[0].query, 'vault search ranking');
  });

  it('writes nothing when there is no query field', () => {
    run({
      hook_event_name: 'PostToolUse',
      tool_name: 'SomeOther',
      tool_input: { unrelated: 'value' },
      tool_response: {},
    });

    assert.equal(readRetrieval('episodic-queries').length, 0);
  });

  it('exits 0 on malformed input (defensive)', () => {
    assert.doesNotThrow(() =>
      execFileSync('node', [HOOK], {
        input: 'not json',
        encoding: 'utf-8',
        env: { ...process.env, CLAUDE_PLUGIN_DATA: PLUGIN_DATA },
        timeout: 5000,
      }),
    );
  });
});
