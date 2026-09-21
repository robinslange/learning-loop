import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript, walkTranscript } from '../plugin/scripts/lib/transcript-walk.mjs';

const rec = (o) => JSON.stringify(o);
const user = (ts, content, extra = {}) =>
  rec({ type: 'user', timestamp: ts, message: { role: 'user', content }, ...extra });
const assistant = (ts, blocks) =>
  rec({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: blocks } });

const FIXTURE = [
  user('2026-09-21T01:00:00.000Z', 'fix the flaky test in ledger.test.mjs'),
  assistant('2026-09-21T01:00:05.000Z', [
    { type: 'text', text: 'Looking at it now.' },
    {
      type: 'tool_use',
      name: 'Read',
      input: { file_path: '/repo/tests/ledger.test.mjs' },
      caller: { type: 'direct' },
    },
  ]),
  user('2026-09-21T01:00:06.000Z', [
    { type: 'tool_result', tool_use_id: 'x', content: 'file body' },
  ]),
  assistant('2026-09-21T01:00:10.000Z', [
    {
      type: 'tool_use',
      name: 'Edit',
      input: { file_path: '/repo/tests/ledger.test.mjs', old_string: 'a', new_string: 'b' },
    },
    {
      type: 'tool_use',
      name: 'Skill',
      input: { skill: 'learning-loop:quick-note', args: 'x' },
      caller: { type: 'hook' },
    },
  ]),
  user(
    '2026-09-21T01:00:11.000Z',
    '<local-command-caveat>Caveat: generated</local-command-caveat>',
  ),
  user('2026-09-21T01:00:12.000Z', [{ type: 'text', text: 'now run it' }]),
  user('2026-09-21T01:00:13.000Z', 'meta line', { isMeta: true }),
  '{"type":"assistant","timestamp":"2026-09-21T01:00:14.000Z","message":{"content":[{"type":"text","te', // truncated
].join('\n');

test('parseTranscript skips a truncated final line and counts it', () => {
  const records = parseTranscript(FIXTURE);
  assert.equal(records.length, 7);
  assert.equal(records.at(-1).timestamp, '2026-09-21T01:00:13.000Z');
});

test('walkTranscript yields only real user prompts', () => {
  const w = walkTranscript(parseTranscript(FIXTURE));
  assert.deepEqual(
    w.prompts.map((p) => p.text),
    ['fix the flaky test in ledger.test.mjs', 'now run it'],
  );
  assert.equal(w.prompts[0].ts, '2026-09-21T01:00:00.000Z');
});

test('walkTranscript yields tool uses with the direct rule: absent caller counts as direct', () => {
  const w = walkTranscript(parseTranscript(FIXTURE));
  assert.deepEqual(
    w.toolUses.map((t) => [t.name, t.direct]),
    [
      ['Read', true],
      ['Edit', true],
      ['Skill', false],
    ],
  );
  assert.equal(w.toolUses[1].input.file_path, '/repo/tests/ledger.test.mjs');
});

test('walkTranscript yields assistant text and first/last timestamps', () => {
  const w = walkTranscript(parseTranscript(FIXTURE));
  assert.deepEqual(
    w.assistantTexts.map((a) => a.text),
    ['Looking at it now.'],
  );
  assert.equal(w.firstTs, '2026-09-21T01:00:00.000Z');
  assert.equal(w.lastTs, '2026-09-21T01:00:13.000Z');
});

test('empty and non-string input walk to an empty result', () => {
  for (const input of ['', null, undefined]) {
    const w = walkTranscript(parseTranscript(input));
    assert.deepEqual(w, {
      prompts: [],
      toolUses: [],
      assistantTexts: [],
      firstTs: null,
      lastTs: null,
      skippedLines: 0,
    });
  }
});
