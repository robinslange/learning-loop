// tests/usage-probe.test.mjs
// The automatic end-of-session usage probe. It exists because usage ground
// truth otherwise comes only from sessions where someone ran /reflect, a
// self-selected slice that every retrieval-quality claim is graded against.
//
// The honesty contract constrains it hard: classifyUsage folds ANY status
// other than the literal 'used' to 'ignored', so a probe that emitted a
// third status for "I could not tell" would manufacture definitive
// non-use at scale. It emits `used` on mechanical evidence and stays
// silent otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeTranscriptUsage } from '../plugin/scripts/lib/usage-probe.mjs';

const surfaced = [
  { path: '3-permanent/alpha.md', via: ['injected'] },
  { path: '3-permanent/beta.md', via: ['retrieved'] },
  { path: '0-inbox/gamma.md', via: ['injected'] },
];

const line = (obj) => JSON.stringify(obj);

test('a Read of a surfaced note is engagement', () => {
  const transcript = [
    line({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Read', input: { file_path: '/v/3-permanent/alpha.md' } },
        ],
      },
    }),
  ].join('\n');
  const found = probeTranscriptUsage(transcript, surfaced);
  assert.deepEqual(found, [{ path: '3-permanent/alpha.md', signals: ['read'] }]);
});

test('an Edit of a surfaced note is engagement', () => {
  const transcript = line({
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', name: 'Edit', input: { file_path: '/vault/3-permanent/beta.md' } },
      ],
    },
  });
  const found = probeTranscriptUsage(transcript, surfaced);
  assert.deepEqual(found, [{ path: '3-permanent/beta.md', signals: ['edited'] }]);
});

test('a wikilink to a surfaced note written in assistant text is engagement', () => {
  const transcript = line({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'This follows from [[alpha]] directly.' }] },
  });
  const found = probeTranscriptUsage(transcript, surfaced);
  assert.deepEqual(found, [{ path: '3-permanent/alpha.md', signals: ['linked'] }]);
});

test('surfacing alone is never use', () => {
  // The note's path appears in the transcript only because the injection hook
  // put it there. Injection deciding a note is relevant cannot also be the
  // evidence that it worked.
  const transcript = [
    line({
      type: 'user',
      message: { content: '<vault-note>3-permanent/alpha.md ...</vault-note>' },
    }),
    line({ type: 'system', content: 'injected 3-permanent/alpha.md' }),
  ].join('\n');
  assert.deepEqual(probeTranscriptUsage(transcript, surfaced), []);
});

test('a note the session never touched produces no event at all', () => {
  // Not an `ignored` event: absence of a mechanical signal is not evidence of
  // non-use, and the aggregator would read any non-`used` status as definitive.
  const transcript = line({
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', name: 'Read', input: { file_path: '/v/3-permanent/alpha.md' } },
      ],
    },
  });
  const found = probeTranscriptUsage(transcript, surfaced);
  assert.equal(found.length, 1);
  assert.ok(!found.some((f) => f.path === '0-inbox/gamma.md'));
});

test('the pipeline reading a note for its own duplicate scan is not engagement', () => {
  // Hook-chain reads fire without model involvement. /reflect's own Step 4.7
  // excludes them by hand; a mechanical probe has to as well.
  const transcript = line({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          name: 'Read',
          input: { file_path: '/v/3-permanent/alpha.md' },
          _meta: { hook: true },
        },
      ],
    },
  });
  const found = probeTranscriptUsage(transcript, surfaced, { skipHookReads: true });
  assert.deepEqual(found, []);
});

test('several signals on one note collapse to one event', () => {
  const transcript = [
    line({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Read', input: { file_path: '/v/3-permanent/alpha.md' } },
        ],
      },
    }),
    line({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Edit', input: { file_path: '/v/3-permanent/alpha.md' } },
        ],
      },
    }),
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'see [[alpha]]' }] } }),
  ].join('\n');
  const found = probeTranscriptUsage(transcript, surfaced);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].signals.slice().sort(), ['edited', 'linked', 'read']);
});

test('a malformed transcript line does not sink the probe', () => {
  const transcript = [
    'not json at all',
    '{"truncated": ',
    line({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Read', input: { file_path: '/v/3-permanent/alpha.md' } },
        ],
      },
    }),
  ].join('\n');
  assert.deepEqual(probeTranscriptUsage(transcript, surfaced), [
    { path: '3-permanent/alpha.md', signals: ['read'] },
  ]);
});

test('empty inputs are answered with nothing, not with a crash', () => {
  assert.deepEqual(probeTranscriptUsage('', surfaced), []);
  assert.deepEqual(probeTranscriptUsage('{}', []), []);
  assert.deepEqual(probeTranscriptUsage(null, null), []);
});

test('a wikilink whose stem collides with a different folder resolves by stem', () => {
  // Two surfaced notes can share a basename across folders. A bare [[stem]]
  // cannot disambiguate, so it must not credit the wrong one; crediting both
  // would invent use.
  const ambiguous = [
    { path: '3-permanent/dup.md', via: ['injected'] },
    { path: '0-inbox/dup.md', via: ['injected'] },
  ];
  const transcript = line({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'see [[dup]]' }] },
  });
  assert.deepEqual(probeTranscriptUsage(transcript, ambiguous), []);
});
