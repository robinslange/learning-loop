import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderMarkdown, writeReport } from '../plugin/scripts/dream-eval/report.mjs';

test('renderMarkdown surfaces the control verdict', () => {
  const md = renderMarkdown({
    mode: 'control',
    verdict: 'tie',
    consolidated: { hit_rate: 0.7, mrr: 0.6, by_tier: { forward: { hit_rate: 0.7 }, reverse: { hit_rate: 0.6 } } },
    control: { hit_rate: 0.71, mrr: 0.61, by_tier: { forward: { hit_rate: 0.71 }, reverse: { hit_rate: 0.6 } } },
  });
  assert.ok(md.includes('tie'));
  assert.ok(md.toLowerCase().includes('control'));
});

test('writeReport writes both json and md at the given stamp', () => {
  const pd = mkdtempSync(join(tmpdir(), 'pd-'));
  const [jsonPath, mdPath] = writeReport(pd, { mode: 'single', before: { hit_rate: 1, mrr: 1, by_tier: { forward: {}, reverse: {} } }, after: { hit_rate: 1, mrr: 1, by_tier: { forward: {}, reverse: {} } } }, '20260716-000000');
  assert.ok(existsSync(jsonPath));
  assert.ok(existsSync(mdPath));
  assert.ok(JSON.parse(readFileSync(jsonPath, 'utf8')).mode === 'single');
});
