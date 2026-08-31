// tests/shipped-docs-pointers.test.mjs
// Skills point operators at documentation. Anything they name as a local file
// must actually ship inside plugin/ — the marketplace source is ./plugin, so a
// pointer at a repo-root file resolves for a git checkout and dangles for every
// installed user.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PLUGIN = join(import.meta.dirname, '..', 'plugin');
const SKILLS = join(PLUGIN, 'skills');

function skillFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return skillFiles(p);
    return e.name === 'SKILL.md' ? [p] : [];
  });
}

test('the operator README ships with the plugin', () => {
  assert.ok(
    existsSync(join(PLUGIN, 'README.md')),
    'plugin/README.md must exist: skills point operators at it by CLAUDE_PLUGIN_ROOT',
  );
});

test('the shipped README documents the sections skills send operators to', () => {
  const readme = readFileSync(join(PLUGIN, 'README.md'), 'utf8');
  for (const heading of ['Disabling parts without uninstalling', 'hooks.disabled', 'disableAllHooks']) {
    assert.ok(readme.includes(heading), `shipped README must document "${heading}"`);
  }
});

test('no SKILL.md points at a doc path that does not ship', () => {
  const dangling = [];
  for (const file of skillFiles(SKILLS)) {
    const text = readFileSync(file, 'utf8');
    // Local doc references: `guide/x.md`, `README.md`, `${CLAUDE_PLUGIN_ROOT}/y.md`.
    // A full https:// URL is an explicit off-box pointer and is fine.
    const re = /(?<!\/)(?:\$\{CLAUDE_PLUGIN_ROOT\}\/)?((?:guide|docs)\/[\w./-]+\.md|README\.md)/g;
    for (const m of text.matchAll(re)) {
      const after = text.slice(m.index + m[0].length);
      if (after.startsWith('](http')) continue; // link text for an explicit URL
      const lineStart = text.lastIndexOf('\n', m.index) + 1;
      const before = text.slice(lineStart, m.index);
      if (/https?:\/\/\S*$/.test(before)) continue; // inside a URL
      if (!existsSync(join(PLUGIN, m[1]))) dangling.push(`${file}: ${m[0]}`);
    }
  }
  assert.deepEqual(dangling, [], `skills reference docs that do not ship:\n${dangling.join('\n')}`);
});
