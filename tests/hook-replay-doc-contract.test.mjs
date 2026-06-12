import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The writing agents' output contracts guarantee wikilink-filled bodies
// (note-deepener requires at least one wiki-link; note-writer templates
// [[related-note]] lines from related_notes), so an unlinked-body filter can
// never select their notes. The canonical sweep in hook-replay.md must seed
// known subagent-written paths into the candidate file unconditionally, with
// the unlinked-body walk as append-only backfill — otherwise deepened notes
// and counterpoints never get edge inference.

const DOC = readFileSync(
  join(import.meta.dirname, '..', 'plugin', 'skills', '_shared', 'hook-replay.md'),
  'utf8',
);

function canonicalBashBlock() {
  const block = DOC.match(/```bash\n([\s\S]*?)```/);
  assert.ok(block, 'hook-replay.md canonical bash block missing');
  return block[1];
}

test('canonical sweep seeds known paths before the unlinked-body walk', () => {
  const bash = canonicalBashBlock();
  const seedIdx = bash.indexOf('>> "$SWEEP_CANDIDATES"');
  const walkIdx = bash.indexOf('python3 -');
  assert.notEqual(walkIdx, -1, 'unlinked-body walk missing from canonical block');
  assert.ok(
    seedIdx !== -1 && seedIdx < walkIdx,
    'canonical block must append known subagent-written paths to $SWEEP_CANDIDATES before the unlinked-body walk',
  );
});

test('unlinked-body walk appends — a truncating redirect would drop seeded paths', () => {
  const bash = canonicalBashBlock();
  assert.match(
    bash,
    /<<'PY' >> "\$SWEEP_CANDIDATES"/,
    'python walk must append (>>) to the candidate file',
  );
  assert.doesNotMatch(
    bash,
    /<<'PY' > "\$SWEEP_CANDIDATES"/,
    'python walk must not truncate (>) the candidate file — that reduces the sweep to the unlinked-body filter alone',
  );
});

test('doc instructs collecting subagent-reported paths for the seed', () => {
  const canonicalSection = DOC.slice(
    DOC.indexOf('## Canonical sweep'),
    DOC.indexOf('## Targeted variant'),
  );
  assert.match(
    canonicalSection,
    /[Ss]eed known paths/,
    'canonical section must carry the seed-known-paths step',
  );
  assert.match(
    canonicalSection,
    /cannot detect the notes this sweep exists to cover/,
    'canonical section must explain why the unlinked-body walk alone is insufficient',
  );
});
