import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const HOOK = join(import.meta.dirname, '..', 'hooks', 'post-write-backlink.js');
const VAULT = '/tmp/ll-test-vault-backlink';

function run(toolName, filePath, content, success = true) {
  const input = JSON.stringify({
    hook_event_name: 'PostToolUse',
    tool_name: toolName,
    tool_input: { file_path: filePath, content },
    tool_response: { filePath, success },
  });
  execFileSync('node', [HOOK], {
    input,
    encoding: 'utf-8',
    env: { ...process.env, VAULT_PATH: VAULT },
    timeout: 5000,
  });
}

describe('post-write-backlink', () => {
  before(() => {
    mkdirSync(join(VAULT, '0-inbox'), { recursive: true });
    mkdirSync(join(VAULT, '3-permanent'), { recursive: true });
    mkdirSync(join(VAULT, '3-permanent', 'sub'), { recursive: true });
  });

  after(() => {
    rmSync(VAULT, { recursive: true, force: true });
  });

  it('appends backlink to target when missing', () => {
    writeFileSync(join(VAULT, '3-permanent', 'target-note.md'), '---\ntitle: target\n---\nSome content.\n');
    const sourceContent = '---\ntags: [test]\n---\nLinks to [[target-note]].';
    run('Write', join(VAULT, '0-inbox', 'source-note.md'), sourceContent);

    const targetAfter = readFileSync(join(VAULT, '3-permanent', 'target-note.md'), 'utf-8');
    assert.ok(targetAfter.includes('[[source-note]]'), 'target should contain backlink to source');
  });

  it('does not duplicate existing backlink', () => {
    writeFileSync(join(VAULT, '3-permanent', 'dedup-target.md'), '---\ntitle: dedup\n---\nContent.\n');
    const sourceContent = '---\ntags: [test]\n---\nLinks to [[dedup-target]].';
    const sourcePath = join(VAULT, '0-inbox', 'dedup-source.md');

    run('Write', sourcePath, sourceContent);
    run('Write', sourcePath, sourceContent);

    const targetAfter = readFileSync(join(VAULT, '3-permanent', 'dedup-target.md'), 'utf-8');
    const matches = targetAfter.match(/\[\[dedup-source\]\]/g);
    assert.equal(matches.length, 1, 'should have exactly one backlink');
  });

  it('does not self-link', () => {
    writeFileSync(join(VAULT, '0-inbox', 'self-ref.md'), '---\ntitle: self\n---\nOriginal.\n');
    const sourceContent = '---\ntags: [test]\n---\nLinks to [[self-ref]].';
    run('Write', join(VAULT, '0-inbox', 'self-ref.md'), sourceContent);

    const content = readFileSync(join(VAULT, '0-inbox', 'self-ref.md'), 'utf-8');
    assert.ok(!content.includes('[[self-ref]]') || content === sourceContent,
      'should not append self-backlink');
  });

  it('ignores non-vault writes', () => {
    writeFileSync(join(VAULT, '3-permanent', 'outside-target.md'), '---\ntitle: outside\n---\nContent.\n');
    const sourceContent = 'Links to [[outside-target]].';
    run('Write', '/tmp/other/file.md', sourceContent);

    const targetAfter = readFileSync(join(VAULT, '3-permanent', 'outside-target.md'), 'utf-8');
    assert.ok(!targetAfter.includes('[[file]]'), 'should not modify target for non-vault writes');
  });

  it('ignores failed writes', () => {
    writeFileSync(join(VAULT, '3-permanent', 'fail-target.md'), '---\ntitle: fail\n---\nContent.\n');
    const sourceContent = '---\ntags: [test]\n---\nLinks to [[fail-target]].';
    run('Write', join(VAULT, '0-inbox', 'fail-source.md'), sourceContent, false);

    const targetAfter = readFileSync(join(VAULT, '3-permanent', 'fail-target.md'), 'utf-8');
    assert.ok(!targetAfter.includes('[[fail-source]]'), 'should not backlink on failed write');
  });

  it('handles notes with no wikilinks', () => {
    const sourceContent = '---\ntags: [test]\n---\nNo links here.';
    assert.doesNotThrow(() => {
      run('Write', join(VAULT, '0-inbox', 'no-links.md'), sourceContent);
    });
  });
});
