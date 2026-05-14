import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEdit } from '../scripts/refinement-validate.mjs';

const FM = '---\nname: t\n---\n';

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
