import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The Verify router lives inline in skills/research/workflow.js, because the
// Workflow sandbox can't import a module. These cases run against that copy,
// with the quorum constants read from the same file, so the tested code is
// the code that runs.
const WORKFLOW = fileURLToPath(new URL('../plugin/skills/research/workflow.js', import.meta.url));
const src = readFileSync(WORKFLOW, 'utf8');

function extract(name) {
  const start = src.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, `workflow.js must define ${name} inline`);
  let depth = 0;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

function constant(name) {
  const m = src.match(new RegExp(`^const ${name} = (\\d+);$`, 'm'));
  assert.ok(m, `workflow.js must declare ${name}`);
  return m[0];
}

const { computeSurvives, normalizeMechanical, normalizeGlm, auditOutcome } = new Function(
  [
    constant('REFUTATIONS_REQUIRED'),
    constant('VOTES_PER_CLAIM'),
    extract('computeSurvives'),
    extract('normalizeMechanical'),
    extract('normalizeGlm'),
    extract('auditOutcome'),
    'return { computeSurvives, normalizeMechanical, normalizeGlm, auditOutcome };',
  ].join('\n'),
)();

// ─── computeSurvives: quorum-aware, distinguishes refuted from "no quorum" ───

test('computeSurvives: 3 valid votes, 0 refuted -> survives', () => {
  assert.deepEqual(computeSurvives([{ refuted: false }, { refuted: false }, { refuted: false }]), {
    survives: true,
    inconclusive: false,
  });
});

test('computeSurvives: 2 of 3 refuted -> killed', () => {
  assert.deepEqual(computeSurvives([{ refuted: true }, { refuted: true }, { refuted: false }]), {
    survives: false,
    inconclusive: false,
  });
});

test('computeSurvives: zero valid votes -> inconclusive, NOT a kill', () => {
  const r = computeSurvives([]);
  assert.equal(r.inconclusive, true);
  assert.notEqual(r.survives, false, 'verifier failure must not read as adversarial refutation');
});

test('computeSurvives: one valid not-refuting vote (2 failed) -> inconclusive, not a kill', () => {
  const r = computeSurvives([{ refuted: false }]);
  assert.equal(r.inconclusive, true);
  assert.notEqual(r.survives, false);
});

test('computeSurvives: one valid REFUTING vote (2 failed) -> still inconclusive (no quorum to kill)', () => {
  const r = computeSurvives([{ refuted: true }]);
  assert.equal(r.inconclusive, true);
});

// ─── normalizeMechanical: only a recognized verdict short-circuits ───

test('normalizeMechanical: clean pass with boolean survives short-circuits, carrying its evidence', () => {
  const r = normalizeMechanical({
    exitCode: 0,
    result: { verdict: 'pass', survives: true, evidence: 'PMID 123 abstract matches' },
  });
  assert.deepEqual(r, {
    shortCircuit: true,
    survives: true,
    verdict: 'pass',
    evidence: 'PMID 123 abstract matches',
  });
});

test('normalizeMechanical: defer falls through to GLM', () => {
  const r = normalizeMechanical({ exitCode: 0, result: { verdict: 'defer', survives: null } });
  assert.equal(r.shortCircuit, false);
});

test('normalizeMechanical: missing verdict does NOT short-circuit to a kill', () => {
  const r = normalizeMechanical({ exitCode: 0, result: {} });
  assert.equal(r.shortCircuit, false, 'a malformed result must fall through, not silently kill');
});

test('normalizeMechanical: verdict present but survives non-boolean falls through', () => {
  const r = normalizeMechanical({ exitCode: 0, result: { verdict: 'pass' } });
  assert.equal(r.shortCircuit, false);
});

test('normalizeMechanical: non-zero exit falls through', () => {
  const r = normalizeMechanical({ exitCode: 1, stderr: 'boom' });
  assert.equal(r.shortCircuit, false);
});

test('normalizeMechanical: null out falls through', () => {
  assert.equal(normalizeMechanical(null).shortCircuit, false);
});

// ─── normalizeGlm: recompute survives from verdicts, never trust the scalar ───

test('normalizeGlm: recomputes survives from verdicts (ignores a dropped survives field)', () => {
  const r = normalizeGlm({
    exitCode: 0,
    result: { verdicts: [{ refuted: false }, { refuted: false }, { refuted: true }] },
  });
  assert.equal(r.ok, true);
  assert.equal(
    r.survives,
    true,
    'recomputed 2/3 not-refuted -> survives, even with survives omitted',
  );
});

test('normalizeGlm: recomputed kill when 2/3 refuted, even if transcribed survives:true', () => {
  const r = normalizeGlm({
    exitCode: 0,
    result: {
      survives: true,
      verdicts: [{ refuted: true }, { refuted: true }, { refuted: false }],
    },
  });
  assert.equal(r.survives, false);
});

test('normalizeGlm: empty/garbled verdicts -> not ok (route to Claude fallback)', () => {
  assert.equal(normalizeGlm({ exitCode: 0, result: {} }).ok, false);
  assert.equal(normalizeGlm({ exitCode: 3, stderr: 'no glm' }).ok, false);
  assert.equal(normalizeGlm(null).ok, false);
});

// ─── auditOutcome: <quorum is "inconclusive", not a Claude disagreement ───

test('auditOutcome: both reached quorum and agree -> agreed', () => {
  const r = auditOutcome(true, [{ refuted: false }, { refuted: false }, { refuted: false }]);
  assert.deepEqual(r, { status: 'agreed', claudeSurvives: true });
});

test('auditOutcome: both reached quorum and disagree -> disagreed', () => {
  const r = auditOutcome(true, [{ refuted: true }, { refuted: true }, { refuted: false }]);
  assert.equal(r.status, 'disagreed');
  assert.equal(r.claudeSurvives, false);
});

test('auditOutcome: audit could not reach quorum -> inconclusive, NOT a disagreement', () => {
  const r = auditOutcome(true, [{ refuted: false }]); // 2 votes failed
  assert.equal(r.status, 'inconclusive');
});

test('auditOutcome: all audit votes failed -> inconclusive', () => {
  assert.equal(auditOutcome(false, []).status, 'inconclusive');
});
