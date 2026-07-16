import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractDistinctiveTokens, mineReverse } from '../plugin/scripts/dream-eval/mine-probes.mjs';

test('extractDistinctiveTokens keeps proper nouns and numbers, drops filler', () => {
  const toks = extractDistinctiveTokens('Robin uses Vyvanse 30mg with the Kinso monorepo');
  assert.ok(toks.includes('Vyvanse'));
  assert.ok(toks.includes('Kinso'));
  assert.ok(!toks.includes('uses'));
});

test('mineReverse binds a token hit to the source memory file', () => {
  const mem = mkdtempSync(join(tmpdir(), 'mem-'));
  writeFileSync(join(mem, 'kinso.md'), 'Kinso salary was 185000');
  const grep = (tok) => (tok === 'Kinso' ? [{ session: 's1', line: 'what was Kinso salary again?' }] : []);
  const probes = mineReverse({ memoryDir: mem, archiveDir: '/unused', grep });
  const hit = probes.find((p) => p.expected_files.includes('kinso.md'));
  assert.ok(hit);
  assert.strictEqual(hit.tier, 'reverse');
});
