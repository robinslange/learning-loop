import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs, readIndexEntries } from '../plugin/scripts/dream-eval/cli.mjs';

test('parseArgs defaults to single mode, 10 passes, no mine', () => {
  assert.deepStrictEqual(parseArgs([]), { mode: 'single', passes: 10, mine: false });
});

test('parseArgs reads mode, passes, and mine flags', () => {
  assert.deepStrictEqual(parseArgs(['--mode=control', '--mine']), { mode: 'control', passes: 10, mine: true });
  assert.deepStrictEqual(parseArgs(['--mode=repeated', '--passes=5']), { mode: 'repeated', passes: 5, mine: false });
});

test('parseArgs rejects an unknown mode', () => {
  assert.throws(() => parseArgs(['--mode=bogus']), /unknown mode/i);
});

test('readIndexEntries parses the memory filenames an _index file lists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-'));
  writeFileSync(
    join(dir, '_index_feedback.md'),
    [
      '# Feedback (2) index',
      '',
      '- [feedback_one.md](feedback_one.md) — first rule.',
      '- [feedback_two.md](feedback_two.md) — second rule.',
    ].join('\n'),
  );
  assert.deepStrictEqual(readIndexEntries(dir, '_index_feedback.md'), [
    'feedback_one.md',
    'feedback_two.md',
  ]);
});

test('readIndexEntries returns [] for a missing index file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-'));
  assert.deepStrictEqual(readIndexEntries(dir, '_index_absent.md'), []);
});
