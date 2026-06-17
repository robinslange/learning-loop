import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The Verify router lives inline in skills/research/SKILL.md (the Workflow sandbox
// can't import a module). verify-route.mjs is the tested source of truth; this test
// extracts the inline copies from SKILL.md and asserts they behave identically, so the
// two can't silently drift.

const SKILL = new URL('../plugin/skills/research/SKILL.md', import.meta.url).pathname;
const md = readFileSync(SKILL, 'utf8');

function extractFn(name) {
  // Grab `function <name>(...) { ... }` balancing braces from the first `{`.
  const start = md.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, `SKILL.md must define ${name} inline`);
  let i = md.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < md.length; j++) {
    if (md[j] === '{') depth++;
    else if (md[j] === '}') {
      depth--;
      if (depth === 0) return md.slice(start, j + 1);
    }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

const REFUTATIONS_REQUIRED = 2;
const VOTES_PER_CLAIM = 3;
const src = [
  'const REFUTATIONS_REQUIRED = ' + REFUTATIONS_REQUIRED + ';',
  'const VOTES_PER_CLAIM = ' + VOTES_PER_CLAIM + ';',
  extractFn('computeSurvives'),
  extractFn('normalizeMechanical'),
  extractFn('normalizeGlm'),
  extractFn('auditOutcome'),
  'return { computeSurvives, normalizeMechanical, normalizeGlm, auditOutcome };',
].join('\n');
const inline = new Function(src)();

test('SKILL.md declares the same VOTES_PER_CLAIM / REFUTATIONS_REQUIRED', () => {
  assert.match(md, /const VOTES_PER_CLAIM = 3;/);
  assert.match(md, /const REFUTATIONS_REQUIRED = 2;/);
});

test('inline computeSurvives: quorum verdicts and inconclusive on <quorum', () => {
  assert.deepEqual(inline.computeSurvives([{ refuted: false }, { refuted: false }]), {
    survives: true,
    inconclusive: false,
  });
  assert.deepEqual(inline.computeSurvives([{ refuted: true }, { refuted: true }]), {
    survives: false,
    inconclusive: false,
  });
  assert.equal(inline.computeSurvives([]).inconclusive, true);
  assert.equal(inline.computeSurvives([{ refuted: false }]).inconclusive, true);
});

test('inline normalizeMechanical: only recognized verdict + boolean survives short-circuits', () => {
  assert.equal(
    inline.normalizeMechanical({ exitCode: 0, result: { verdict: 'pass', survives: true } })
      .shortCircuit,
    true,
  );
  assert.equal(inline.normalizeMechanical({ exitCode: 0, result: {} }).shortCircuit, false);
  assert.equal(
    inline.normalizeMechanical({ exitCode: 0, result: { verdict: 'defer', survives: null } })
      .shortCircuit,
    false,
  );
  assert.equal(inline.normalizeMechanical(null).shortCircuit, false);
});

test('inline normalizeGlm: recomputes survives from verdicts, ignores transcribed scalar', () => {
  const a = inline.normalizeGlm({
    exitCode: 0,
    result: { verdicts: [{ refuted: false }, { refuted: false }, { refuted: true }] },
  });
  assert.equal(a.ok, true);
  assert.equal(a.survives, true);
  const b = inline.normalizeGlm({
    exitCode: 0,
    result: {
      survives: true,
      verdicts: [{ refuted: true }, { refuted: true }, { refuted: false }],
    },
  });
  assert.equal(b.survives, false);
  assert.equal(inline.normalizeGlm({ exitCode: 0, result: {} }).ok, false);
});

test('inline auditOutcome: <quorum -> inconclusive, never a disagreement', () => {
  assert.equal(inline.auditOutcome(true, [{ refuted: false }]).status, 'inconclusive');
  assert.equal(
    inline.auditOutcome(true, [{ refuted: false }, { refuted: false }, { refuted: false }]).status,
    'agreed',
  );
  assert.equal(
    inline.auditOutcome(true, [{ refuted: true }, { refuted: true }, { refuted: false }]).status,
    'disagreed',
  );
});
