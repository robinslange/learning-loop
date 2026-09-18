import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALIASES,
  SCHEMA_CLASSES,
  checkFrontmatter,
  formatViolations,
  hasBodyCitation,
  hasUngroundedFactualSignal,
} from '../plugin/scripts/lib/frontmatter-schema.mjs';

const codes = (fm) =>
  checkFrontmatter(fm)
    .map((v) => v.id)
    .sort();

describe('frontmatter-schema contract', () => {
  it('passes a conforming note', () => {
    assert.deepEqual(
      checkFrontmatter({ tags: ['a'], date: '2026-08-03', source: 'synthesis' }),
      [],
    );
  });

  it('reports each required key that is absent', () => {
    assert.deepEqual(codes({}), ['missing:date', 'missing:source', 'missing:tags']);
  });

  it('distinguishes an empty key from an absent one', () => {
    assert.deepEqual(codes({ tags: [], date: '2026-08-03', source: 'synthesis' }), ['empty:tags']);
  });

  it('flags every deprecated alias', () => {
    const fm = { tags: ['a'], created: '2026-08-03', 'source-project': 'x' };
    const ids = codes(fm);
    for (const alias of Object.keys(ALIASES)) {
      if (alias in fm) assert.ok(ids.includes(`alias:${alias}`), `expected alias:${alias}`);
    }
  });

  it('rejects a non-ISO date', () => {
    const fm = { tags: ['a'], date: '03-08-2026', source: 'synthesis' };
    assert.ok(codes(fm).includes('bad-date:date'));
  });

  it('rejects a folder name in status: but accepts an intention value', () => {
    const base = { tags: ['a'], date: '2026-08-03', source: 'synthesis' };
    assert.ok(codes({ ...base, status: 'permanent' }).includes('bad-status:status'));
    assert.deepEqual(codes({ ...base, status: 'limbo' }), []);
  });

  it('scopes the contract to atomic folders only', () => {
    for (const c of ['inbox', 'fleeting', 'literature', 'permanent'])
      assert.ok(SCHEMA_CLASSES.has(c));
    for (const c of ['project', 'map', 'system', 'other']) assert.ok(!SCHEMA_CLASSES.has(c));
  });

  it('names the replacement key in the deny text', () => {
    const text = formatViolations(checkFrontmatter({ tags: ['a'], created: '2026-08-03' }));
    assert.match(text, /`created:` is not a vault key\. Use `date:`/);
  });

  it('describes source: as an origin, not a citation', () => {
    const text = formatViolations(checkFrontmatter({}));
    assert.match(text, /capture ORIGIN/);
    assert.match(text, /body `Source:` line/);
  });
});

describe('frontmatter-schema grounding signals', () => {
  it('sees a body Source: line', () => {
    assert.equal(hasBodyCitation('Body text.\n\nSource: https://example.com'), true);
    assert.equal(hasBodyCitation('Body text.\n\nSources:\n- https://example.com'), true);
  });

  it('does not mistake prose for a citation line', () => {
    assert.equal(hasBodyCitation('The source of the bug was a race.'), false);
  });

  // Regression: an earlier pass judged groundedness on wikilinks alone and
  // stamped 99 cited notes as uncited because their URLs were in the body.
  it('ignores a Source: line inside a fenced block', () => {
    assert.equal(hasBodyCitation('Body.\n\n```\nSource: not-a-real-citation\n```\n'), false);
  });

  it('flags a bare figure with a unit', () => {
    assert.equal(hasUngroundedFactualSignal('Recall improved by 23% in the trial.'), true);
  });

  it('accepts a figure grounded by a wikilink in the same paragraph', () => {
    assert.equal(
      hasUngroundedFactualSignal('Recall improved by 23%, per [[some-grounded-note]].'),
      false,
    );
  });

  it('ignores figures inside fenced blocks', () => {
    assert.equal(hasUngroundedFactualSignal('Body.\n\n```\nlatency: 45ms\n```\n'), false);
  });

  it('treats a first-hand note with no checkable claim as clean', () => {
    assert.equal(hasUngroundedFactualSignal('The gate denies what the write introduces.'), false);
  });

  it('still reads a figure whose digit run carries separators', () => {
    assert.equal(hasUngroundedFactualSignal('The dump was 1,234.5mb before the sweep.'), true);
    assert.equal(hasUngroundedFactualSignal('Throughput held at 1,000x baseline.'), true);
  });

  it('finishes on a long separator-heavy digit run that matches nothing', () => {
    // A pasted id list or a long decimal is ordinary vault content. The
    // quantity pattern can start at every digit of a run and walks the rest
    // from each start, so this shape cost 20s at this length and stalled the
    // whole normalise-frontmatter pass on one note.
    const body = '1' + ',1'.repeat(100_000);
    const start = Date.now();
    assert.equal(hasUngroundedFactualSignal(body), false);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 500, `expected a linear scan, took ${elapsed}ms`);
  });

  it('still reads a real figure in a paragraph that also holds a long run', () => {
    // Clipping bounds the run, it does not skip the paragraph: a note pasting
    // an id list beside a claim still owes that claim a source.
    const body = `Recall improved by 23% in the trial. ids: ${'9'.repeat(5000)}`;
    assert.equal(hasUngroundedFactualSignal(body), true);
  });

  it('reads a figure written without a leading zero', () => {
    assert.equal(hasUngroundedFactualSignal('The error rate dropped to .5% after the fix.'), true);
  });

  it('keeps a long digit run that a unit follows', () => {
    // The clip exists to drop id lists, not quantities. A run past the bound
    // with a unit after it is a real figure however implausible its length.
    assert.equal(hasUngroundedFactualSignal('9'.repeat(60) + 'mg of it'), true);
    assert.equal(hasUngroundedFactualSignal('9'.repeat(60) + ' mg of it'), true);
  });

  it('keeps the digits a trigger needs when the run past them is clipped', () => {
    // n=, p<0. and a bare comparator trigger BEFORE their digits, so a clip
    // that ate the whole run would take the signal with it.
    assert.equal(hasUngroundedFactualSignal('n=' + '9'.repeat(60)), true);
    assert.equal(hasUngroundedFactualSignal('p<0.' + '9'.repeat(60)), true);
    assert.equal(hasUngroundedFactualSignal('<' + '9'.repeat(60)), true);
  });
});
