import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLink, classifyNoteEdges } from '../scripts/lib/edge-classifier.mjs';

const fakeResolver = name => `3-permanent/${name}.md`;

describe('edge-classifier verb-position direction', () => {
  it('keeps direction when verb appears before link (source proves [[X]])', () => {
    const ctx = 'Our experiment proves [[target]] in laboratory conditions.';
    const result = classifyLink(ctx, 'target');
    assert.equal(result.type, 'evidence_for');
    assert.equal(result.flip, false);
  });

  it('flips direction when verb appears after link ([[X]] proves Y)', () => {
    const ctx = '[[target]] confirms the broader pattern documented earlier.';
    const result = classifyLink(ctx, 'target');
    assert.equal(result.type, 'evidence_for');
    assert.equal(result.flip, true);
  });

  it('flips for em-dash verb-after pattern at medium confidence', () => {
    const ctx = '[[target]] — counter-evidence: the proposed mechanism does not replicate.';
    const result = classifyLink(ctx, 'target');
    assert.equal(result.flip, true);
  });

  it('flips for double em-dash prefix', () => {
    const ctx = '[[target]] -- counter-evidence: replication failed at three sites.';
    const result = classifyLink(ctx, 'target');
    assert.equal(result.flip, true);
  });

  it('keeps for "Challenges [[X]]" pattern', () => {
    const ctx = 'The new finding fundamentally Challenges [[target]] across three dimensions.';
    const result = classifyLink(ctx, 'target');
    assert.equal(result.type, 'challenges_undermining');
    assert.equal(result.flip, false);
  });

  it('keeps for "Builds on [[X]]" pattern', () => {
    const ctx = 'This approach Builds on [[target]] for the core mechanism.';
    const result = classifyLink(ctx, 'target');
    assert.equal(result.type, 'derived_from');
    assert.equal(result.flip, false);
  });

  it('abstains (flip=false) when verb appears on both sides', () => {
    const ctx = 'Our experiment proves [[target]] confirms the broader pattern.';
    const result = classifyLink(ctx, 'target');
    assert.equal(result.flip, false);
  });

  it('handles trailing colon on before-side verb (Challenges: [[X]])', () => {
    const ctx = 'See also Challenges: [[target]] for the counter-argument.';
    const result = classifyLink(ctx, 'target');
    assert.equal(result.type, 'challenges_undermining');
    assert.equal(result.flip, false);
  });

  it('classifyNoteEdges marks flip=true when verb appears after link', () => {
    const content = '# Source\n\n[[target]] proves the broader claim.\n';
    const edges = classifyNoteEdges(content, 'source-note', fakeResolver);
    assert.equal(edges.length, 1);
    assert.equal(edges[0].toPath, '3-permanent/target.md');
    assert.equal(edges[0].edgeType, 'evidence_for');
    assert.equal(edges[0].flip, true);
  });

  it('classifyNoteEdges marks flip=false when verb appears before link', () => {
    const content = '# Source\n\nThis proves [[target]] holds in practice.\n';
    const edges = classifyNoteEdges(content, 'source-note', fakeResolver);
    assert.equal(edges.length, 1);
    assert.equal(edges[0].toPath, '3-permanent/target.md');
    assert.equal(edges[0].flip, false);
  });
});
