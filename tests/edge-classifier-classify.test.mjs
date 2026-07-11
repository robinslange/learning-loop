import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyLink,
  classifyNoteEdges,
  extractLinksWithContext,
  makeResolver,
} from '../plugin/scripts/lib/edge-classifier.mjs';

// The existing direction test pins only `.flip` on a handful of examples. These
// tests pin the classification behaviour the mutation baseline left open:
//   - which edge type / confidence tier each verb class resolves to,
//   - the high-beats-medium and array-order precedence,
//   - the sentence-boundary window trimming in classifyLink,
//   - link extraction (alias, anchor, empty target, context window),
//   - the classifyNoteEdges guards (self-link, resolver, edge shape),
//   - detectFlip's AND (not OR) between the two verb-position sides.

describe('edge-classifier: edge-type / confidence classification', () => {
  // One high verb and one medium verb per type. Pins the .type string and the
  // confidence tier for every PATTERNS entry — kills the "empty the regex array"
  // and "swap the type literal" mutants across all six types.
  const cases = [
    // derived_from
    ['This builds on [[target]] for the mechanism.', 'derived_from', 'high'],
    ['This extends [[target]] considerably.', 'derived_from', 'high'],
    ['It sets the baseline [[target]] uses.', 'derived_from', 'high'],
    ['This inspired by [[target]] originally.', 'derived_from', 'medium'],
    ['The idea comes from [[target]] directly.', 'derived_from', 'medium'],
    // evidence_for
    ['Our data proves [[target]] holds.', 'evidence_for', 'high'],
    ['This demonstrates [[target]] clearly.', 'evidence_for', 'high'],
    ['We confirm [[target]] under load.', 'evidence_for', 'high'],
    ['This validates [[target]] empirically.', 'evidence_for', 'high'],
    ['It shows that [[target]] scales.', 'evidence_for', 'medium'],
    // supports
    ['This reinforces [[target]] strongly.', 'supports', 'high'],
    ['It strengthens [[target]] materially.', 'supports', 'high'],
    ['This corroborates [[target]] independently.', 'supports', 'high'],
    ['It aligns with [[target]] neatly.', 'supports', 'medium'],
    ['This is consistent with [[target]] throughout.', 'supports', 'medium'],
    // challenges_undermining
    ['This contradicts [[target]] directly.', 'challenges_undermining', 'high'],
    ['It refutes [[target]] outright.', 'challenges_undermining', 'high'],
    ['This disproves [[target]] cleanly.', 'challenges_undermining', 'high'],
    ['It challenges [[target]] on three counts.', 'challenges_undermining', 'medium'],
    // challenges_undercutting
    ['This undercuts [[target]] entirely.', 'challenges_undercutting', 'high'],
    ['It weakens the basis [[target]] rests on.', 'challenges_undercutting', 'high'],
    ['This weakens [[target]] somewhat.', 'challenges_undercutting', 'medium'],
    // challenges_rebuttal
    ['This rebuts [[target]] point by point.', 'challenges_rebuttal', 'high'],
    ['It debunks [[target]] convincingly.', 'challenges_rebuttal', 'high'],
    ['This counters [[target]] plainly.', 'challenges_rebuttal', 'medium'],
  ];

  for (const [ctx, type, confidence] of cases) {
    it(`classifies "${ctx.slice(0, 34)}…" → ${type}/${confidence}`, () => {
      const result = classifyLink(ctx, 'target');
      assert.ok(result, 'expected a classification');
      assert.equal(result.type, type);
      assert.equal(result.confidence, confidence);
    });
  }

  it('returns null when no pattern matches', () => {
    assert.equal(classifyLink('See [[target]] for more context.', 'target'), null);
  });

  it('returns null when the target link is absent from the context', () => {
    assert.equal(classifyLink('This proves [[other]] holds.', 'target'), null);
  });
});

describe('edge-classifier: precedence', () => {
  it('high beats medium even when the medium verb is a different type', () => {
    // "aligns with" = supports/medium; "proves" = evidence_for/high. The high
    // pass runs across ALL patterns before any medium pass, so evidence_for wins.
    const r = classifyLink('This proves [[target]] and aligns with prior work.', 'target');
    assert.equal(r.type, 'evidence_for');
    assert.equal(r.confidence, 'high');
  });

  it('within the high tier, PATTERNS array order decides (derived_from before evidence_for)', () => {
    // "builds on" = derived_from/high (index 0); "proves" = evidence_for/high
    // (index 1). Iteration order picks derived_from. A reordered PATTERNS or a
    // merged loop would return evidence_for.
    const r = classifyLink('This builds on [[target]] and proves the claim.', 'target');
    assert.equal(r.type, 'derived_from');
    assert.equal(r.confidence, 'high');
  });

  it('falls to the medium tier only when no high verb matches anywhere', () => {
    const r = classifyLink('This aligns with [[target]] and is consistent with it.', 'target');
    assert.equal(r.confidence, 'medium');
    assert.equal(r.type, 'supports');
  });
});

describe('edge-classifier: classifyLink window boundaries', () => {
  it('ignores a verb that sits before a sentence boundary (. )', () => {
    // "proves" is trimmed off the before-window at ". " → no verb before, and
    // nothing after → null. Kills the beforeBoundary slice / !== -1 mutants.
    assert.equal(classifyLink('X proves something. Then we cite [[target]] casually.', 'target'), null);
  });

  it('ignores a verb that sits after a following-sentence boundary', () => {
    // The after-window is cut at ". " so the verb in the next sentence is unseen.
    assert.equal(classifyLink('We mention [[target]] here. This proves an unrelated claim.', 'target'), null);
  });

  it('stops the after-window at the next wiki-link', () => {
    // "proves" belongs to the [[other]] link, not [[target]]; the after-window is
    // cut at "[[" so target stays unclassified.
    assert.equal(classifyLink('We list [[target]] then [[other]] proves the point.', 'target'), null);
  });

  it('reads a verb immediately before the link (no boundary in between)', () => {
    const r = classifyLink('The result proves [[target]] conclusively.', 'target');
    assert.equal(r.type, 'evidence_for');
    assert.equal(r.flip, false);
  });

  it('cuts the after-window at the NEAREST boundary, not the farthest', () => {
    // Two different boundary delimiters follow the link ("! " at 0, ". " at 8),
    // with a verb between them. The window must end at the nearest ("! "),
    // excluding "proves" → null. Taking the farthest boundary would wrongly pull
    // "proves" in and classify the link.
    assert.equal(classifyLink('[[target]]! proves. end', 'target'), null);
  });
});

describe('edge-classifier: extractLinksWithContext', () => {
  it('strips an alias pipe from the target', () => {
    const links = extractLinksWithContext('body proves [[real-target|shown as this]] end');
    assert.equal(links.length, 1);
    assert.equal(links[0].target, 'real-target');
  });

  it('strips a heading anchor from the target', () => {
    const links = extractLinksWithContext('body [[real-target#section]] proves it');
    assert.equal(links.length, 1);
    assert.equal(links[0].target, 'real-target');
  });

  it('skips an empty target', () => {
    assert.equal(extractLinksWithContext('an empty [[]] link and [[#only-anchor]] here').length, 0);
  });

  it('captures the surrounding context window around the link', () => {
    const links = extractLinksWithContext('alpha proves [[target]] omega');
    assert.equal(links.length, 1);
    assert.ok(links[0].context.includes('proves'), 'context includes the preceding verb');
    assert.ok(links[0].context.includes('omega'), 'context includes trailing text');
    assert.equal(links[0].position, 'alpha proves '.length);
  });

  it('finds multiple links in one body', () => {
    const links = extractLinksWithContext('proves [[a]] and refutes [[b]] here');
    assert.deepEqual(links.map((l) => l.target), ['a', 'b']);
  });
});

describe('edge-classifier: classifyNoteEdges guards', () => {
  const resolver = (name) => `3-permanent/${name}.md`;

  it('skips a self-referential link', () => {
    assert.deepEqual(classifyNoteEdges('proves [[me]] here', 'me'), []);
  });

  it('skips a link that classifies to nothing', () => {
    assert.deepEqual(classifyNoteEdges('see [[target]] casually', 'src'), []);
  });

  it('defaults toPath to the bare target when no resolver is given', () => {
    const edges = classifyNoteEdges('proves [[target]] here', 'src');
    assert.equal(edges.length, 1);
    assert.equal(edges[0].toPath, 'target');
    assert.equal(edges[0].edgeType, 'evidence_for');
    assert.equal(edges[0].confidence, 'high');
  });

  it('drops a link the resolver cannot resolve', () => {
    assert.deepEqual(classifyNoteEdges('proves [[target]] here', 'src', () => null), []);
  });

  it('stores the resolver path as toPath when resolved', () => {
    const edges = classifyNoteEdges('proves [[target]] here', 'src', resolver);
    assert.equal(edges.length, 1);
    assert.equal(edges[0].toPath, '3-permanent/target.md');
  });

  it('emits one edge per distinct classified link', () => {
    const content = 'This proves [[a]] and this refutes [[b]] entirely.';
    const edges = classifyNoteEdges(content, 'src', resolver);
    assert.equal(edges.length, 2);
    assert.deepEqual(
      edges.map((e) => [e.toPath, e.edgeType]).sort(),
      [
        ['3-permanent/a.md', 'evidence_for'],
        ['3-permanent/b.md', 'challenges_undermining'],
      ],
    );
  });
});

describe('edge-classifier: makeResolver', () => {
  it('returns the mapped path for a known target', () => {
    const resolve = makeResolver(new Map([['foo', '3-permanent/foo.md']]));
    assert.equal(resolve('foo'), '3-permanent/foo.md');
  });

  it('returns null for an unknown target (not undefined)', () => {
    const resolve = makeResolver(new Map());
    assert.equal(resolve('missing'), null);
  });
});

describe('edge-classifier: detectFlip AND-not-OR', () => {
  // detectFlip returns true only when the verb is after AND not before. These
  // three cases together distinguish `&&` from `||` and pin each return branch.
  it('verb only before → flip false', () => {
    assert.equal(classifyLink('This proves [[target]] beyond doubt.', 'target').flip, false);
  });

  it('verb only after → flip true', () => {
    assert.equal(classifyLink('[[target]] proves the broader claim.', 'target').flip, true);
  });

  it('verb on both sides → flip false (abstain)', () => {
    // With `||` instead of `&&`, verbInAfter alone would flip this to true.
    assert.equal(classifyLink('proves [[target]] proves again', 'target').flip, false);
  });

  it('flip uses the same confidence tier as the match (medium verb after)', () => {
    // "aligns with" is medium-only; detectFlip must be handed pattern.medium.
    const r = classifyLink('[[target]] aligns with the broader framework.', 'target');
    assert.equal(r.confidence, 'medium');
    assert.equal(r.flip, true);
  });
});
