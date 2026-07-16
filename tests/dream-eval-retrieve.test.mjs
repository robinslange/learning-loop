import { test } from 'node:test';
import assert from 'node:assert';
import {
  buildPickPrompt,
  retrieve,
  isIndexFile,
  retrieveTwoHop,
} from '../plugin/scripts/dream-eval/retrieve.mjs';

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

test('isIndexFile detects the _index_*.md split-index pointers', () => {
  assert.strictEqual(isIndexFile('_index_feedback.md'), true);
  assert.strictEqual(isIndexFile('_index_project.md'), true);
  assert.strictEqual(isIndexFile('user_location_nz.md'), false);
  assert.strictEqual(isIndexFile('feedback_foo.md'), false);
});

test('retrieveTwoHop keeps a directly-picked memory file (User-tier, one hop)', async () => {
  // hop 1 picks a real file listed in MEMORY.md; no second hop needed.
  const pick = async () => '{"paths": ["user_location_nz.md"]}';
  const readIndexFile = () => {
    throw new Error('should not read an index for a direct pick');
  };
  const r = await retrieveTwoHop({ question: 'where does Robin live?', indexText: 'i', pick, readIndexFile });
  assert.deepStrictEqual(r, ['user_location_nz.md']);
});

test('retrieveTwoHop resolves an index pick through a second pick over its entries', async () => {
  // hop 1 picks _index_feedback.md; hop 2 picks the real target from its listed files.
  let call = 0;
  const pick = async () => {
    call += 1;
    return call === 1
      ? '{"paths": ["_index_feedback.md"]}' // hop 1: land on the index
      : '{"paths": ["feedback_branch_over_worktree.md"]}'; // hop 2: pick target from index entries
  };
  const readIndexFile = (path) => {
    assert.strictEqual(path, '_index_feedback.md');
    return ['feedback_branch_over_worktree.md', 'feedback_other.md'];
  };
  const r = await retrieveTwoHop({ question: 'worktree preference?', indexText: 'i', pick, readIndexFile });
  assert.deepStrictEqual(r, ['feedback_branch_over_worktree.md']);
});

test('retrieveTwoHop drops an index whose second hop yields nothing, never throws', async () => {
  let call = 0;
  const pick = async () => {
    call += 1;
    return call === 1 ? '{"paths": ["_index_project.md"]}' : 'garbage not json';
  };
  const readIndexFile = () => ['project_a.md', 'project_b.md'];
  const r = await retrieveTwoHop({ question: 'q', indexText: 'i', pick, readIndexFile });
  assert.deepStrictEqual(r, []);
});
