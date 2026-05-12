import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFlags } from '../scripts/regenerate-viz.mjs';

test('parseFlags returns defaults when no args', () => {
  const flags = parseFlags([]);
  assert.equal(flags.dryRun, false);
  assert.equal(flags.skipFrontmatter, false);
  assert.equal(flags.skipHeatmap, false);
  assert.equal(flags.skipCycles, false);
});

test('parseFlags recognises --dry-run', () => {
  const flags = parseFlags(['--dry-run']);
  assert.equal(flags.dryRun, true);
});

test('parseFlags recognises skip flags', () => {
  const flags = parseFlags(['--no-frontmatter', '--no-heatmap', '--no-cycles']);
  assert.equal(flags.skipFrontmatter, true);
  assert.equal(flags.skipHeatmap, true);
  assert.equal(flags.skipCycles, true);
});

test('parseFlags throws on unknown flag', () => {
  assert.throws(() => parseFlags(['--bogus']), /unknown flag/i);
});
