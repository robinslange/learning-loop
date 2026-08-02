// Shared fixture filter for everything that reads the shadow-injection stream.
//
// The session-label tests used to invoke the real hook without overriding
// CLAUDE_PLUGIN_DATA (fixed in 97d6bfa), so their prompts are in the historical
// record and carry nothing marking them synthetic. Every consumer of that
// stream has to exclude them or its numbers are part test-suite.
//
// One implementation, derived from the test source at run time. Three separate
// copies is how the filter silently rots: the --live-only replay path lost its
// copy and spent twenty minutes scoring a single test session that holds 4510
// of the 6122 live turns on record.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const TEST_FILE = join(import.meta.dirname, '..', 'tests', 'session-label.test.mjs');

// A prefix long enough that a real prompt is unlikely to collide, short enough
// to survive the trailing variation tests add.
const PREFIX = 40;

function loadFixturePrefixes() {
  const src = readFileSync(TEST_FILE, 'utf8');
  const out = new Set();
  for (const m of src.matchAll(/['"`]([^'"`\n]{15,200})['"`]/g)) {
    const s = m[1];
    if (/^[/.~]/.test(s) || /^[A-Z_]+$/.test(s) || s.includes('${')) continue;
    out.add(s.slice(0, PREFIX));
  }
  return [...out];
}

export const FIXTURE_PREFIXES = loadFixturePrefixes();

export function isFixturePrompt(prompt) {
  const p = prompt || '';
  return FIXTURE_PREFIXES.some((f) => p.startsWith(f));
}

// A session whose prompts are overwhelmingly fixtures is a test run, and its
// remaining prompts are test scaffolding too. Catching it at session level
// removes the long tail of one-off strings the literal scan cannot see: the
// 2026-07-14 test session logged 8996 records from 17 distinct prompts.
export function isFixtureSession(prompts) {
  if (!prompts.length) return false;
  const distinct = [...new Set(prompts)];
  // Very low prompt diversity over many turns is not human conversation.
  if (prompts.length >= 100 && distinct.length <= 25) return true;
  const fixtureShare = distinct.filter(isFixturePrompt).length / distinct.length;
  return fixtureShare >= 0.5;
}
