import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearAllNliFrontmatter } from '../scripts/clear-nli-frontmatter.mjs';

test('strips NLI keys from every affected note, leaves others alone', async () => {
  const vaultRoot = mkdtempSync(join(tmpdir(), 'll-clear-'));
  mkdirSync(join(vaultRoot, '3-permanent'), { recursive: true });
  const a = join(vaultRoot, '3-permanent', 'a.md');
  const b = join(vaultRoot, '3-permanent', 'b.md');
  writeFileSync(a, '---\ntags: [foo]\nnli-contradicts: ["[[x]]"]\nhas-contradiction: true\n---\n\n# A\n');
  writeFileSync(b, '---\nrelated: ["[[y]]"]\n---\n\n# B\n');

  const counts = await clearAllNliFrontmatter(vaultRoot);
  assert.equal(counts.cleared, 1);

  const aContent = readFileSync(a, 'utf-8');
  assert.doesNotMatch(aContent, /nli-contradicts/);
  assert.doesNotMatch(aContent, /has-contradiction/);
  assert.match(aContent, /tags: \[foo\]/);

  const bContent = readFileSync(b, 'utf-8');
  assert.match(bContent, /related: \["\[\[y\]\]"\]/);

  rmSync(vaultRoot, { recursive: true, force: true });
});
