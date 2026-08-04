import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWrites } from '../plugin/hooks/lib/tool-payload.mjs';

const CWD = '/repo';

describe('normalizeWrites — Claude Code payloads', () => {
  it('passes a Write through unchanged', () => {
    const out = normalizeWrites({
      tool_name: 'Write',
      tool_input: { file_path: '/v/a.md', content: 'body' },
    });
    assert.deepEqual(out, [{ tool: 'Write', file_path: '/v/a.md', content: 'body' }]);
  });

  it('passes an Edit through unchanged', () => {
    const out = normalizeWrites({
      tool_name: 'Edit',
      tool_input: { file_path: '/v/a.md', old_string: 'x', new_string: 'y' },
    });
    assert.deepEqual(out, [
      { tool: 'Edit', file_path: '/v/a.md', old_string: 'x', new_string: 'y' },
    ]);
  });

  it('returns nothing for a tool that touches no file', () => {
    assert.deepEqual(normalizeWrites({ tool_name: 'Task', tool_input: { description: 'x' } }), []);
  });

  it('drops a Write with no file_path', () => {
    assert.deepEqual(normalizeWrites({ tool_name: 'Write', tool_input: { content: 'x' } }), []);
  });

  it('tolerates a missing payload', () => {
    assert.deepEqual(normalizeWrites(undefined), []);
    assert.deepEqual(normalizeWrites({ tool_name: 'apply_patch' }), []);
  });
});

describe('normalizeWrites — Codex apply_patch', () => {
  it('maps Add File to a Write carrying the added body', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: 0-inbox/note.md',
      '+---',
      '+tags: [a]',
      '+---',
      '+',
      '+A claim.',
      '*** End Patch',
    ].join('\n');

    assert.deepEqual(
      normalizeWrites({ tool_name: 'apply_patch', tool_input: { command: patch }, cwd: CWD }),
      [
        {
          tool: 'Write',
          file_path: '/repo/0-inbox/note.md',
          content: '---\ntags: [a]\n---\n\nA claim.',
        },
      ],
    );
  });

  it('maps an Update File hunk to an Edit whose old_string matches disk', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: 0-inbox/note.md',
      '@@',
      ' context line',
      '-old text',
      '+new text',
      ' trailing context',
      '*** End Patch',
    ].join('\n');

    assert.deepEqual(
      normalizeWrites({ tool_name: 'apply_patch', tool_input: { command: patch }, cwd: CWD }),
      [
        {
          tool: 'Edit',
          file_path: '/repo/0-inbox/note.md',
          old_string: 'context line\nold text\ntrailing context',
          new_string: 'context line\nnew text\ntrailing context',
        },
      ],
    );
  });

  it('emits one Edit per hunk', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: a.md',
      '@@',
      '-one',
      '+ONE',
      '@@',
      '-two',
      '+TWO',
      '*** End Patch',
    ].join('\n');

    const out = normalizeWrites({
      tool_name: 'apply_patch',
      tool_input: { command: patch },
      cwd: CWD,
    });
    assert.equal(out.length, 2);
    assert.deepEqual(
      out.map((w) => [w.old_string, w.new_string]),
      [
        ['one', 'ONE'],
        ['two', 'TWO'],
      ],
    );
  });

  it('splits a patch that touches several files', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: new.md',
      '+fresh',
      '*** Update File: old.md',
      '@@',
      '-a',
      '+b',
      '*** Delete File: gone.md',
      '*** End Patch',
    ].join('\n');

    const out = normalizeWrites({
      tool_name: 'apply_patch',
      tool_input: { command: patch },
      cwd: CWD,
    });
    assert.deepEqual(
      out.map((w) => [w.tool, w.file_path]),
      [
        ['Write', '/repo/new.md'],
        ['Edit', '/repo/old.md'],
        ['Delete', '/repo/gone.md'],
      ],
    );
  });

  it('retargets an Update File that is also moved', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: 0-inbox/note.md',
      '*** Move to: 3-permanent/note.md',
      '@@',
      '-draft',
      '+final',
      '*** End Patch',
    ].join('\n');

    const out = normalizeWrites({
      tool_name: 'apply_patch',
      tool_input: { command: patch },
      cwd: CWD,
    });
    assert.deepEqual(out, [
      {
        tool: 'Edit',
        file_path: '/repo/3-permanent/note.md',
        old_string: 'draft',
        new_string: 'final',
      },
    ]);
  });

  it('keeps absolute patch paths absolute', () => {
    const patch = ['*** Begin Patch', '*** Add File: /abs/note.md', '+x', '*** End Patch'].join(
      '\n',
    );
    const out = normalizeWrites({
      tool_name: 'apply_patch',
      tool_input: { command: patch },
      cwd: CWD,
    });
    assert.equal(out[0].file_path, '/abs/note.md');
  });
});
