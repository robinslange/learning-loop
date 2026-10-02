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
//   - which edge type each verb class resolves to, and which verbs are too
//     weak to classify at all,
//   - the array-order precedence,
//   - the sentence-boundary window trimming in classifyLink,
//   - link extraction (alias, anchor, empty target, context window),
//   - the classifyNoteEdges guards (self-link, resolver, edge shape),
//   - detectFlip's AND (not OR) between the two verb-position sides.

describe('edge-classifier: edge-type / confidence classification', () => {
  // Verbs per type. Pins the .type string for every PATTERNS entry — kills
  // the "empty the regex array" and "swap the type literal" mutants across all
  // six types.
  const cases = [
    // derived_from
    ['This builds on [[target]] for the mechanism.', 'derived_from'],
    ['This extends [[target]] considerably.', 'derived_from'],
    ['It sets the baseline [[target]] uses.', 'derived_from'],
    // evidence_for
    ['Our data proves [[target]] holds.', 'evidence_for'],
    ['This demonstrates [[target]] clearly.', 'evidence_for'],
    ['We confirm [[target]] under load.', 'evidence_for'],
    ['This validates [[target]] empirically.', 'evidence_for'],
    // supports
    ['This reinforces [[target]] strongly.', 'supports'],
    ['It strengthens [[target]] materially.', 'supports'],
    ['This corroborates [[target]] independently.', 'supports'],
    // challenges_undermining
    ['This contradicts [[target]] directly.', 'challenges_undermining'],
    ['It refutes [[target]] outright.', 'challenges_undermining'],
    ['This disproves [[target]] cleanly.', 'challenges_undermining'],
    ['It challenges [[target]] on three counts.', 'challenges_undermining'],
    ['Challenges [[target]] — the sample was too small.', 'challenges_undermining'],
    // challenges_undercutting
    ['This undercuts [[target]] entirely.', 'challenges_undercutting'],
    ['It weakens the basis [[target]] rests on.', 'challenges_undercutting'],
    // challenges_rebuttal
    ['This rebuts [[target]] point by point.', 'challenges_rebuttal'],
    ['It debunks [[target]] convincingly.', 'challenges_rebuttal'],
    ['This counters [[target]] plainly.', 'challenges_rebuttal'],
    ['Counterpoint: [[target]] ignores the base rate.', 'challenges_rebuttal'],
  ];

  for (const [ctx, type] of cases) {
    it(`classifies "${ctx.slice(0, 34)}…" → ${type}`, () => {
      const result = classifyLink(ctx, 'target');
      assert.ok(result, 'expected a classification');
      assert.equal(result.type, type);
      assert.equal(result.confidence, 'high');
    });
  }

  // Weaker verbs say too little to be argued. They classify as nothing here,
  // and classifyNoteEdges records the link as a co-mention instead.
  const weak = [
    'This inspired by [[target]] originally.',
    'The idea comes from [[target]] directly.',
    'It shows that [[target]] scales.',
    'It aligns with [[target]] neatly.',
    'This is consistent with [[target]] throughout.',
    'This weakens [[target]] somewhat.',
    'There is tension with [[target]] here.',
    // Counterpoint markers in their ordinary-word uses.
    'One of the challenges of [[target]] is cost.',
    'Its challenges are [[target]] and cost.',
    'The challenges in [[target]] remain.',
    'The challenges for [[target]] remain.',
    'The challenges with [[target]] remain.',
    'The main challenge is [[target]].',
    'The trust-challenge matrix connects to [[target]].',
    'Phase 1 challenge-response is [[target]].',
    'This is counter-intuitive given [[target]].',
    'A non-counterpoint [[target]] note.',
    'Its ring-counters feed [[target]].',
    '[[target]] is relevant -- self-authored counterpoints risk bias.',
    '47 notes, 8 counterpoints, 10 blindspots at [[target]].',
  ];
  for (const ctx of weak) {
    it(`does not classify the weak verb in "${ctx.slice(0, 34)}…"`, () => {
      assert.equal(classifyLink(ctx, 'target'), null);
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
  it('a weak verb beside a strong one does not change the strong verdict', () => {
    // "aligns with" no longer classifies; "proves" = evidence_for.
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

  it('a verb decides type and direction before a counterpoint marker does', () => {
    // undermining comes first in PATTERNS, so a single pass would let
    // "challenge" outrank the undercut verb and take its direction too.
    const both = classifyLink('This challenges and undercuts [[target]].', 'target');
    assert.equal(both.type, 'challenges_undercutting');
    const after = classifyLink('Undercuts [[target]] as a challenge.', 'target');
    assert.deepEqual([after.type, after.flip], ['challenges_undercutting', false]);
    const rebut = classifyLink('Challenges [[target]] and debunks it.', 'target');
    assert.deepEqual([rebut.type, rebut.flip], ['challenges_rebuttal', true]);
  });

  it('a cue does not read across the link it sits beside', () => {
    // The link is cut out of the window. Read as one string, "challenges"
    // would meet the "for" after the link and pass as the noun use.
    const r = classifyLink('Challenges [[target]] for ignoring the base rate.', 'target');
    assert.equal(r?.type, 'challenges_undermining');
  });

  it('weak verbs alone classify as nothing', () => {
    assert.equal(
      classifyLink('This aligns with [[target]] and is consistent with it.', 'target'),
      null,
    );
  });
});

describe('edge-classifier: classifyLink window boundaries', () => {
  it('ignores a verb that sits before a sentence boundary (. )', () => {
    // "proves" is trimmed off the before-window at ". " → no verb before, and
    // nothing after → null. Kills the beforeBoundary slice / !== -1 mutants.
    assert.equal(
      classifyLink('X proves something. Then we cite [[target]] casually.', 'target'),
      null,
    );
  });

  it('ignores a verb that sits after a following-sentence boundary', () => {
    // The after-window is cut at ". " so the verb in the next sentence is unseen.
    assert.equal(
      classifyLink('We mention [[target]] here. This proves an unrelated claim.', 'target'),
      null,
    );
  });

  it('stops the after-window at the next wiki-link', () => {
    // "proves" belongs to the [[other]] link, not [[target]]; the after-window is
    // cut at "[[" so target stays unclassified.
    assert.equal(
      classifyLink('We list [[target]] then [[other]] proves the point.', 'target'),
      null,
    );
  });

  it('gives a cue between two links to the next link, not this one', () => {
    const ctx = 'See [[a]] and counterpoint [[target]].';
    assert.equal(classifyLink(ctx, 'a'), null);
    assert.deepEqual(classifyLink(ctx, 'target'), {
      type: 'challenges_rebuttal',
      confidence: 'high',
      flip: true,
    });
    assert.equal(classifyLink('[[a]] proves [[target]] holds.', 'a'), null);
  });

  it('never reads past the next link for a clause end', () => {
    for (const ctx of [
      'See [[a]] and counterpoint [[target]], which argues otherwise.',
      '[[a]] proves [[target]] holds, mostly.',
      'Compare [[a]] with [[counterpoint-b]], and decide.',
      'Read [[a]] first; counterpoint [[target]].',
      'Read [[a]] beside it (counterpoint [[target]]).',
    ]) {
      assert.equal(classifyLink(ctx, 'a'), null, ctx);
    }
  });

  it('keeps the clause or parenthetical right after a link when another link follows', () => {
    assert.deepEqual(
      classifyLink('[[a]] — counter-evidence: the effect vanishes in [[target]].', 'a'),
      { type: 'challenges_rebuttal', confidence: 'high', flip: true },
    );
    for (const ctx of [
      '[[a]] confirms this, as does [[target]].',
      '[[a]] confirms this; so does [[target]].',
      '[[a]] confirms this (see [[target]]).',
    ]) {
      assert.deepEqual(
        classifyLink(ctx, 'a'),
        { type: 'evidence_for', confidence: 'high', flip: true },
        ctx,
      );
    }
    assert.equal(
      classifyLink('Sits beside [[a]] (the note it undercuts) and connects to [[target]].', 'a')
        ?.type,
      'challenges_undercutting',
    );
  });

  it('ends both windows at a table cell boundary', () => {
    const row = '| [[a]]: the empirical counterpoint | [[target]]: the economic case |';
    assert.equal(classifyLink(row, 'target'), null);
    assert.equal(classifyLink(row, 'a')?.type, 'challenges_rebuttal');
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
    assert.deepEqual(
      links.map((l) => l.target),
      ['a', 'b'],
    );
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
    assert.deepEqual(
      classifyNoteEdges('proves [[target]] here', 'src', () => null),
      [],
    );
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
    assert.deepEqual(edges.map((e) => [e.toPath, e.edgeType]).sort(), [
      ['3-permanent/a.md', 'evidence_for'],
      ['3-permanent/b.md', 'challenges_undermining'],
    ]);
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

describe('edge-classifier: counterpoint direction', () => {
  // A marker says this note counters the link; a label says the link is the
  // counterpoint. Frontmatter sync writes rebuts:/undermines: for unflipped
  // edges only and never removes a key, so a label read as a marker would put
  // a note's own counterpoints into its rebuts: list.
  const cases = [
    ['Challenges [[target]] — the sample was too small.', 'challenges_undermining', false],
    ['This counters [[target]] plainly.', 'challenges_rebuttal', false],
    ['Counterpoint to [[target]].', 'challenges_rebuttal', false],
    ['Counterpoint to: [[target]]', 'challenges_rebuttal', false],
    ['Counter-argument to [[target]].', 'challenges_rebuttal', false],
    ['Counter evidence to [[target]].', 'challenges_rebuttal', false],
    ['Counter evidence: [[target]]', 'challenges_rebuttal', true],
    // The marker after the link decides, and it must be judged against the
    // markers alone: the label before the link would otherwise read as a cue
    // on both sides, which abstains to unflipped.
    ['Counterpoint: [[target]] counters the claim.', 'challenges_rebuttal', true],
    ['Counterpoint: [[target]] ignores the base rate.', 'challenges_rebuttal', true],
    ['See counterpoint [[target]].', 'challenges_rebuttal', true],
    ['- counterpoint: [[target]]', 'challenges_rebuttal', true],
    ['**Counter-evidence:** [[target]]', 'challenges_rebuttal', true],
    ['The counter-argument the other side will run is [[target]].', 'challenges_rebuttal', true],
    ['[[target]] — counter-evidence: replication failed.', 'challenges_rebuttal', true],
  ];
  for (const [ctx, type, flip] of cases) {
    it(`"${ctx.slice(0, 40)}…" → ${type}${flip ? ', flipped' : ''}`, () => {
      const r = classifyLink(ctx, 'target');
      assert.deepEqual([r?.type, r?.flip], [type, flip]);
    });
  }
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

  it("flip is judged on the matched pattern's own verbs (counterpoint verb after)", () => {
    // "challenges" belongs to challenges_undermining; detectFlip must be handed
    // that pattern's verbs, or it finds no verb after and keeps the direction.
    const r = classifyLink('[[target]] challenges the broader framework.', 'target');
    assert.equal(r.type, 'challenges_undermining');
    assert.equal(r.flip, true);
  });
});

describe('edge-classifier: repeated links to the same target', () => {
  // The context window is +/-150 chars, so two links to one target usually sit
  // in each other's window. Locating the target by NAME finds the first one
  // both times, and the second link silently inherits the first's verdict —
  // wrong edge_type and confidence in a DB that justification and cycle
  // queries read as ground truth.
  it("gives each link its own verdict, not the first occurrence's", () => {
    const note = 'This contradicts [[foo]] in every respect. Later it reinforces [[foo]] instead.';
    const edges = classifyNoteEdges(note, 'src');
    assert.equal(edges.length, 2);
    assert.equal(edges[0].edgeType, 'challenges_undermining');
    assert.equal(edges[1].edgeType, 'supports');
    assert.notEqual(edges[0].edgeType, edges[1].edgeType);
  });

  it('does not let a later verb reclassify an earlier link', () => {
    const note = 'This proves [[foo]] clearly. But it also undermines [[foo]] elsewhere.';
    const edges = classifyNoteEdges(note, 'src');
    assert.equal(edges.length, 2);
    assert.equal(edges[0].edgeType, 'evidence_for');
    assert.equal(edges[1].edgeType, 'challenges_undermining');
  });

  it('offset locates the link inside its own context slice, not the body', () => {
    // position is absolute; using it as a slice offset would point past the
    // link once the body is longer than the window.
    const pad = 'x'.repeat(400);
    const links = extractLinksWithContext(`${pad} proves [[target]] omega`);
    assert.equal(links.length, 1);
    assert.equal(links[0].context.slice(links[0].offset, links[0].offset + 10), '[[target]]');
    assert.notEqual(links[0].offset, links[0].position);
  });

  it('still classifies when the caller passes no offset', () => {
    assert.equal(
      classifyLink('This proves [[target]] conclusively.', 'target').type,
      'evidence_for',
    );
  });
});

describe('edge-classifier: co-mention tier', () => {
  const resolver = (name) => `3-permanent/${name}.md`;

  it('emits a low-confidence comention edge for a resolved link with no verb', () => {
    const edges = classifyNoteEdges('see also [[target]] for context', 'src', resolver);
    assert.equal(edges.length, 1);
    assert.deepEqual(edges[0], {
      toPath: '3-permanent/target.md',
      edgeType: 'associative',
      confidence: 'low',
      flip: false,
      sourceGraph: 'comention',
    });
  });

  it('records a link beside a weak verb as a comention, not an argued edge', () => {
    const edges = classifyNoteEdges('It aligns with [[target]] neatly.', 'src', resolver);
    assert.deepEqual(
      edges.map((e) => [e.edgeType, e.confidence, e.sourceGraph]),
      [['associative', 'low', 'comention']],
    );
  });

  it('suppresses the comention when any occurrence of the target classifies', () => {
    const content = 'This proves [[target]] here. See also [[target]] again.';
    const edges = classifyNoteEdges(content, 'src', resolver);
    assert.equal(edges.length, 1);
    assert.equal(edges[0].edgeType, 'evidence_for');
  });

  it('emits one comention per distinct plain target, not per occurrence', () => {
    const content = 'See [[a]] and later [[a]] once more, plus [[b]].';
    const edges = classifyNoteEdges(content, 'src', resolver);
    assert.deepEqual(edges.map((e) => e.toPath).sort(), ['3-permanent/a.md', '3-permanent/b.md']);
    assert.ok(edges.every((e) => e.sourceGraph === 'comention'));
  });

  it('emits no comention without a resolver (resolution is the qualifying bar)', () => {
    assert.deepEqual(classifyNoteEdges('see [[target]] casually', 'src'), []);
  });

  it('classified edges carry no sourceGraph (callers default them to local)', () => {
    const edges = classifyNoteEdges('proves [[target]] here', 'src', resolver);
    assert.equal(edges.length, 1);
    assert.equal(edges[0].sourceGraph, undefined);
  });
});
