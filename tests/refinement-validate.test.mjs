import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateEdit } from '../plugin/scripts/refinement-validate.mjs';

const FM = '---\nname: t\n---\n';

function sentences(n) {
  return Array.from({ length: n }, (_, i) => `Sentence number ${i + 1} says something distinct.`);
}

test('preserves upstream em-dashes that the agent kept verbatim', () => {
  const upstream =
    FM +
    '\n# Title\n\n' +
    'max mtime of `.md` files — if nothing changed, skip.\n' +
    'compare hash — if blob is identical, skip.\n';

  const proposed = upstream + '\nNew paragraph the agent added with no em-dashes.\n';

  const result = validateEdit({ decision: 'edit', id: 'x', proposed_body: proposed }, upstream);

  assert.match(
    result.cleaned_body,
    /max mtime of `\.md` files — if nothing changed/,
    'upstream em-dash 1 must survive untouched',
  );
  assert.match(
    result.cleaned_body,
    /compare hash — if blob is identical/,
    'upstream em-dash 2 must survive untouched',
  );
  assert.doesNotMatch(
    result.cleaned_body,
    /files ,  if nothing changed/,
    'must not produce the doubled-space artefact from blanket stripping',
  );
  const violations = result.flags.filter((f) => f.type === 'em_dash_violation');
  assert.deepEqual(
    violations,
    [],
    'agent did not add em-dashes, so no em_dash_violation flag should fire',
  );
});

test('strips em-dashes the agent introduces in new lines', () => {
  const upstream = FM + '\n# Title\n\nOriginal line, no dashes.\n';
  const proposed = upstream + '\nAgent added — this em-dash and — another one too.\n';

  const result = validateEdit({ decision: 'edit', id: 'y', proposed_body: proposed }, upstream);

  assert.match(
    result.cleaned_body,
    /Agent added ,  this em-dash and ,  another/,
    'em-dashes in agent-added lines must be replaced with ", "',
  );
  const violation = result.flags.find((f) => f.type === 'em_dash_violation');
  assert.ok(violation, 'em_dash_violation flag must fire for agent-introduced em-dashes');
  assert.equal(violation.count, 2);
});

test('strips en-dashes the agent introduces the same as em-dashes', () => {
  const upstream = FM + '\n# Title\n\nOriginal line, no dashes.\n';
  const proposed = upstream + '\nAgent added – an en-dash here.\n';

  const result = validateEdit({ decision: 'edit', id: 'n', proposed_body: proposed }, upstream);

  assert.doesNotMatch(result.cleaned_body, /–/, 'en-dash in agent-added line must be stripped');
  assert.match(result.cleaned_body, /Agent added ,  an en-dash here/);
  const violation = result.flags.find((f) => f.type === 'em_dash_violation');
  assert.ok(violation, 'em_dash_violation flag must fire for agent-introduced en-dashes');
  assert.equal(violation.count, 1);
});

test('does not flag when agent adds zero new content', () => {
  const upstream = FM + '\n# Title\n\nLine A — with em-dash.\nLine B.\n';
  const proposed = upstream;

  const result = validateEdit({ decision: 'edit', id: 'z', proposed_body: proposed }, upstream);

  assert.equal(
    result.flags.filter((f) => f.type === 'em_dash_violation').length,
    0,
    'identity edit must not flag em-dashes',
  );
  assert.match(result.cleaned_body, /Line A — with em-dash/);
});

test('mixed case: upstream em-dash preserved, agent em-dash stripped', () => {
  const upstream = FM + '\n# Title\n\nKept line — with dash.\n';
  const proposed = upstream + '\nNew line — added by agent.\n';

  const result = validateEdit({ decision: 'edit', id: 'm', proposed_body: proposed }, upstream);

  assert.match(result.cleaned_body, /Kept line — with dash/, 'upstream line preserved');
  assert.match(result.cleaned_body, /New line ,  added by agent/, 'new line stripped');
  const violation = result.flags.find((f) => f.type === 'em_dash_violation');
  assert.ok(violation);
  assert.equal(violation.count, 1, 'exactly one new-line em-dash should be flagged');
});

test('auto-rejects when an upstream sentence is dropped', () => {
  const s = sentences(5);
  const upstream = FM + '\n# Title\n\n' + s.join(' ') + '\n';
  const proposed = FM + '\n# Title\n\n' + [s[0], s[1], s[3], s[4]].join(' ') + '\n';

  const result = validateEdit({ decision: 'edit', id: 'r1', proposed_body: proposed }, upstream);

  assert.equal(result.status, 'auto_rejected');
  const flag = result.flags.find((f) => f.type === 'sentences_removed');
  assert.ok(flag, 'sentences_removed flag must fire');
  assert.equal(flag.severity, 'auto_rejected');
  assert.equal(flag.removed_count, 1);
  assert.match(flag.removed[0], /Sentence number 3/);
});

test('auto-rejects the remove-N-add-N rewrite that size delta scores as zero', () => {
  const s = sentences(5);
  const upstream = FM + '\n# Title\n\n' + s.join(' ') + '\n';
  const rewritten = [s[0], s[1], 'A totally different replacement claim instead.', s[3], s[4]];
  const proposed = FM + '\n# Title\n\n' + rewritten.join(' ') + '\n';

  const result = validateEdit({ decision: 'edit', id: 'r2', proposed_body: proposed }, upstream);

  const size = result.flags.find((f) => f.type === 'size');
  assert.equal(size, undefined, 'sentence delta is zero, so no size flag (the historic bypass)');
  assert.equal(result.status, 'auto_rejected');
  const flag = result.flags.find((f) => f.type === 'sentences_removed');
  assert.ok(flag, 'rewrite must be caught by the removal check');
  assert.equal(flag.removed_count, 1);
});

test('pure addition passes: in-paragraph insert and appended paragraph, no removal flag', () => {
  const s = sentences(5);
  const upstream =
    FM + '\n# Title\n\n' + s.slice(0, 3).join(' ') + '\n\n' + s.slice(3).join(' ') + '\n';
  const inserted = [s[0], s[1], 'A brand new inserted sentence with evidence.', s[2]];
  const proposed = FM + '\n# Title\n\n' + inserted.join(' ') + '\n\n' + s.slice(3).join(' ') + '\n';

  const result = validateEdit({ decision: 'edit', id: 'a1', proposed_body: proposed }, upstream);

  assert.equal(
    result.flags.find((f) => f.type === 'sentences_removed'),
    undefined,
    'in-paragraph insertion preserves every upstream sentence',
  );
  assert.equal(result.status, 'ok', '1 added sentence on 5 is exactly 20%, not over it');
});

test('whitespace-only changes do not count as removals', () => {
  const upstream = FM + '\n# Title\n\nLine A stays.\n\n\nLine B stays.\n';
  const proposed = FM + '\n# Title\n\nLine A stays.\n\nLine B stays.\n';

  const result = validateEdit({ decision: 'edit', id: 'w1', proposed_body: proposed }, upstream);

  assert.equal(
    result.flags.find((f) => f.type === 'sentences_removed'),
    undefined,
  );
  assert.equal(result.status, 'ok');
});

test('size thresholds: 20% exact is ok, 20-50% warns, >50% auto-rejects', () => {
  const s = sentences(10);
  const upstream = FM + '\n# Title\n\n' + s.join(' ') + '\n';
  const grow = (n) =>
    upstream +
    '\n' +
    sentences(20)
      .slice(10, 10 + n)
      .map((x) => 'Added ' + x)
      .join(' ') +
    '\n';

  const atCeiling = validateEdit({ decision: 'edit', id: 't1', proposed_body: grow(2) }, upstream);
  assert.equal(atCeiling.status, 'ok', 'delta 0.2 is not > 0.2');

  const warned = validateEdit({ decision: 'edit', id: 't2', proposed_body: grow(3) }, upstream);
  assert.equal(warned.status, 'oversized_warning');
  assert.equal(warned.flags.find((f) => f.type === 'size').severity, 'warning');

  const rejected = validateEdit({ decision: 'edit', id: 't3', proposed_body: grow(6) }, upstream);
  assert.equal(rejected.status, 'auto_rejected');
  assert.equal(rejected.flags.find((f) => f.type === 'size').severity, 'auto_rejected');
  for (const r of [atCeiling, warned, rejected]) {
    assert.equal(
      r.flags.find((f) => f.type === 'sentences_removed'),
      undefined,
      'pure growth must never trip the removal check',
    );
  }
});

test('auto-rejects when an upstream fenced code block is deleted', () => {
  const upstream =
    FM +
    '\n# Title\n\nProse before the block stays.\n\n' +
    '```js\nconst backoff = base * 2;\nreturn backoff;\n```\n\n' +
    'Prose after the block stays.\n';
  const proposed =
    FM + '\n# Title\n\nProse before the block stays.\n\nProse after the block stays.\n';

  const result = validateEdit({ decision: 'edit', id: 'cb1', proposed_body: proposed }, upstream);

  assert.equal(result.status, 'auto_rejected');
  const flag = result.flags.find((f) => f.type === 'sentences_removed');
  assert.ok(flag, 'deleting a fenced code block must fire sentences_removed');
  assert.equal(flag.removed_count, 1);
  assert.match(flag.removed[0], /backoff/);
});

test('auto-rejects when an upstream fenced code block is rewritten', () => {
  const upstream =
    FM + '\n# Title\n\nProse stays.\n\n```js\nconst backoff = base * 2;\n```\n\nMore prose.\n';
  const proposed =
    FM + '\n# Title\n\nProse stays.\n\n```js\nconst backoff = base * 999;\n```\n\nMore prose.\n';

  const result = validateEdit({ decision: 'edit', id: 'cb2', proposed_body: proposed }, upstream);

  assert.equal(result.status, 'auto_rejected');
  const flag = result.flags.find((f) => f.type === 'sentences_removed');
  assert.ok(flag, 'rewriting a fenced code block must fire sentences_removed');
  assert.equal(flag.removed_count, 1);
});

test('untouched code block plus added prose passes the removal check', () => {
  const s = sentences(6);
  const upstream =
    FM +
    '\n# Title\n\n' +
    s.slice(0, 3).join(' ') +
    '\n\n```js\nconst backoff = base * 2;\nreturn backoff;\n```\n\n' +
    s.slice(3).join(' ') +
    '\n';
  const proposed = upstream + '\nA brand new prose sentence with supporting evidence.\n';

  const result = validateEdit({ decision: 'edit', id: 'cb3', proposed_body: proposed }, upstream);

  assert.equal(
    result.flags.find((f) => f.type === 'sentences_removed'),
    undefined,
    'untouched block + prose addition must not count as removal',
  );
  assert.equal(result.status, 'ok');
});

test('adding a new code block does not count as removal', () => {
  const upstream = FM + '\n# Title\n\nProse stays here.\n';
  const proposed = upstream + '\n```sh\necho added by agent\n```\n';

  const result = validateEdit({ decision: 'edit', id: 'cb4', proposed_body: proposed }, upstream);

  assert.equal(
    result.flags.find((f) => f.type === 'sentences_removed'),
    undefined,
    'a freshly added block exists only on the proposed side',
  );
  assert.equal(result.status, 'ok');
});

test('emits upstream_hash of the exact body it validated against', () => {
  const upstream = FM + '\n# Title\n\nOnly sentence here.\n';
  const result = validateEdit({ decision: 'edit', id: 'h1', proposed_body: upstream }, upstream);

  assert.equal(result.upstream_hash, createHash('sha256').update(upstream).digest('hex'));
});

test('CRLF note body: frontmatter is extracted, not treated as absent', () => {
  const upstream = '---\r\ntitle: X\r\n---\r\nBody\r\n';
  const proposed = '---\r\ntitle: Y\r\n---\r\nBody\r\n';

  const result = validateEdit({ decision: 'edit', id: 'crlf1', proposed_body: proposed }, upstream);

  assert.equal(
    result.flags.find((f) => f.type === 'sentences_removed'),
    undefined,
    'a frontmatter-only change must never be mistaken for a body sentence removal',
  );
  const mismatch = result.flags.find((f) => f.type === 'frontmatter_modified');
  assert.ok(
    mismatch,
    'a real frontmatter change on a CRLF note must be caught by frontmatter_modified',
  );
  assert.match(
    result.cleaned_body,
    /^---\r\ntitle: X\r\n---\r\n/,
    'reassembled body must keep the UPSTREAM frontmatter verbatim, never the proposed one',
  );
});
