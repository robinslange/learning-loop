import { test } from 'node:test';
import assert from 'node:assert';
import { buildPickPrompt, retrieve } from '../plugin/scripts/dream-eval/retrieve.mjs';

test('buildPickPrompt embeds the question and index', () => {
  const p = buildPickPrompt('what was X?', '# index\n- a.md');
  assert.ok(p.includes('what was X?'));
  assert.ok(p.includes('a.md'));
});

test('retrieve parses a ranked path list from the agent reply', async () => {
  const pick = async () => '```json\n{"paths": ["a.md", "b.md"]}\n```';
  const r = await retrieve({ question: 'q', indexText: 'i', pick });
  assert.deepStrictEqual(r, ['a.md', 'b.md']);
});

test('retrieve returns [] on malformed reply, never throws', async () => {
  const pick = async () => 'not json at all';
  const r = await retrieve({ question: 'q', indexText: 'i', pick });
  assert.deepStrictEqual(r, []);
});
