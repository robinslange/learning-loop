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
          content: '---\ntags: [a]\n---\n\nA claim.\n',
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
          old_string: '\ncontext line\nold text\ntrailing context\n',
          new_string: '\ncontext line\nnew text\ntrailing context\n',
          context: null,
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
        ['\none\n', '\nONE\n'],
        ['\ntwo\n', '\nTWO\n'],
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
        old_string: '\ndraft\n',
        new_string: '\nfinal\n',
        context: null,
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

describe('normalizeWrites — regressions found by adversarial review', () => {
  const patch = (body) =>
    normalizeWrites({ tool_name: 'apply_patch', tool_input: { command: body }, cwd: CWD });

  it('reads a CRLF patch rather than silently seeing no writes at all', () => {
    const body = ['*** Begin Patch', '*** Add File: a.md', '+x', '*** End Patch'].join('\r\n');
    assert.deepEqual(patch(body), [{ tool: 'Write', file_path: '/repo/a.md', content: 'x\n' }]);
  });

  it('line-anchors old_string so a hunk cannot bind mid-line', () => {
    const [edit] = patch(
      [
        '*** Begin Patch',
        '*** Update File: a.md',
        '@@',
        '-beta',
        '+beta two',
        '*** End Patch',
      ].join('\n'),
    );
    const disk = '# D\n\nSource: https://example.com/beta-notes\n\nbeta\n';
    // The naive form would hit the URL; the anchored form must hit the real line.
    assert.equal(disk.indexOf('beta'), disk.indexOf('https://example.com/') + 20);
    assert.equal(disk.indexOf(edit.old_string), disk.lastIndexOf('\nbeta\n'));
  });

  it('carries the @@ anchor so an ambiguous removal can be disambiguated', () => {
    const [edit] = patch(
      [
        '*** Begin Patch',
        '*** Update File: a.md',
        '@@ Bad frontmatter looks like this:',
        '-source: session',
        '*** End Patch',
      ].join('\n'),
    );
    assert.equal(edit.context, 'Bad frontmatter looks like this:');
    const disk =
      '---\nsource: session\n---\n\nBad frontmatter looks like this:\n\nsource: session\n';
    const from = disk.indexOf(edit.context) + edit.context.length;
    // Anchored search must find the body occurrence, not the frontmatter one.
    assert.ok(disk.indexOf(edit.old_string, from) > disk.indexOf(edit.old_string));
  });

  it('does not lose a pending hunk when a Delete File follows it', () => {
    const out = patch(
      [
        '*** Begin Patch',
        '*** Update File: a.md',
        '@@',
        '-a',
        '+b',
        '*** Delete File: gone.md',
        '*** End Patch',
      ].join('\n'),
    );
    assert.deepEqual(
      out.map((w) => w.tool),
      ['Edit', 'Delete'],
    );
  });
});
