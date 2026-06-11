import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canPromote, promoteWithVerification } from '../plugin/scripts/promotion-gate.mjs';

test('canPromote allows clean note with all criteria passing', () => {
  const note = {
    body: 'Active sentence with [[wiki-link]]. Two more lines of substance. Even more.',
    frontmatter: { source: '[Author, "Title" (2024)](https://example.com)', tags: ['neuro'] },
    gateCriteria: { depth: true, sourcing: true, linking: true, voice: true, atomicity: true, sourceIntegrity: true },
  };
  const result = canPromote(note);
  assert.equal(result.allowed, true);
  assert.equal(result.destination, '3-permanent/');
});

test('canPromote blocks promotion when [unresolved] marker present', () => {
  const note = {
    body: 'Active sentence. Authors say X (Smith 2023 [unresolved]). [[wiki-link]].',
    frontmatter: { source: '[Smith, "X" (2023)](https://example.com)' },
    gateCriteria: { depth: true, sourcing: true, linking: true, voice: true, atomicity: true, sourceIntegrity: true },
  };
  const result = canPromote(note);
  assert.equal(result.allowed, false);
  assert.equal(result.destination, '1-fleeting/');
  assert.match(result.reason, /unresolved/);
});

test('canPromote blocks on any of the four markers', () => {
  for (const marker of ['[unresolved]', '[unverified]', '[not in abstract]', '[not in source]']) {
    const note = {
      body: `Body. ${marker} citation here. [[link]].`,
      frontmatter: { source: '[url]' },
      gateCriteria: { depth: true, sourcing: true, linking: true, voice: true, atomicity: true, sourceIntegrity: true },
    };
    const result = canPromote(note);
    assert.equal(result.allowed, false, `marker ${marker} should block`);
  }
});

test('canPromote ignores markers inside fenced code blocks', () => {
  const note = {
    body: 'Real body. ```\n[unresolved]\n``` Real link [[note]].',
    frontmatter: { source: 'synthesis' },
    gateCriteria: { depth: true, sourcing: true, linking: true, voice: true, atomicity: true, sourceIntegrity: true },
  };
  const result = canPromote(note);
  assert.equal(result.allowed, true);
});

test('canPromote routes to 0-inbox when ≤ 2 criteria pass', () => {
  const note = {
    body: 'Thin.',
    frontmatter: {},
    gateCriteria: { depth: false, sourcing: false, linking: false, voice: true, atomicity: true, sourceIntegrity: false },
  };
  const result = canPromote(note);
  assert.equal(result.destination, '0-inbox/');
});

test('canPromote routes to 1-fleeting when 3-4 criteria pass', () => {
  const note = {
    body: 'Body with [[link]].',
    frontmatter: {},
    gateCriteria: { depth: true, sourcing: false, linking: true, voice: true, atomicity: false, sourceIntegrity: false },
  };
  const result = canPromote(note);
  assert.equal(result.destination, '1-fleeting/');
});

test('promoteWithVerification calls verifier when destination is permanent', async () => {
  let verifierCalls = 0;
  const fakeVerifier = async () => {
    verifierCalls++;
    return { highSeverityIssues: 0, warnings: [] };
  };
  const note = {
    path: 'fake/path.md',
    body: 'Body with [[link]] and two more lines of substance here.',
    frontmatter: { source: '[Author](https://example.com)' },
    gateCriteria: { depth: true, sourcing: true, linking: true, voice: true, atomicity: true, sourceIntegrity: true },
  };
  const result = await promoteWithVerification(note, { verifier: fakeVerifier });
  assert.equal(verifierCalls, 1);
  assert.equal(result.allowed, true);
});

test('promoteWithVerification demotes to fleeting on high-severity verification failure', async () => {
  const fakeVerifier = async () => ({ highSeverityIssues: 1, warnings: ['wrong author'] });
  const note = {
    path: 'fake/path.md',
    body: 'Body with [[link]] and substance here. Another line.',
    frontmatter: { source: '[Author](https://example.com)' },
    gateCriteria: { depth: true, sourcing: true, linking: true, voice: true, atomicity: true, sourceIntegrity: true },
  };
  const result = await promoteWithVerification(note, { verifier: fakeVerifier });
  assert.equal(result.allowed, false);
  assert.equal(result.destination, '1-fleeting/');
  assert.match(result.reason, /verification/);
});

test('promoteWithVerification skips verifier for synthesis notes', async () => {
  let calls = 0;
  const fakeVerifier = async () => { calls++; return { highSeverityIssues: 0, warnings: [] }; };
  const note = {
    path: 'fake/path.md',
    body: 'Synthesis body with [[link]] and substance here.',
    frontmatter: { source: 'synthesis' },
    gateCriteria: { depth: true, sourcing: true, linking: true, voice: true, atomicity: true, sourceIntegrity: true },
  };
  const result = await promoteWithVerification(note, { verifier: fakeVerifier });
  assert.equal(calls, 0);
  assert.equal(result.allowed, true);
});

// ---------------------------------------------------------------------------
// 5-maps routing for synthesis hub notes
// ---------------------------------------------------------------------------

const linkDenseBody = (n) =>
  Array.from({ length: n }, (_, i) => `Idea ${i} → see [[ref-note-${i}]].`).join(' ');

test('canPromote routes synthesis hub to 5-maps when link-dense (≥10 wikilinks) via source=synthesis', () => {
  const note = {
    body: linkDenseBody(12),
    frontmatter: { source: 'synthesis', tags: ['anxiety', 'synthesis'] },
    gateCriteria: { depth: true, sourcing: true, linking: true, voice: true, atomicity: true, sourceIntegrity: true },
  };
  const result = canPromote(note);
  assert.equal(result.allowed, true);
  assert.equal(result.destination, '5-maps/');
});

test('canPromote routes synthesis hub to 5-maps when link-dense via synthesis tag (no source frontmatter)', () => {
  const note = {
    body: linkDenseBody(11),
    frontmatter: { tags: ['discovery', 'synthesis'] },
    gateCriteria: { depth: true, sourcing: true, linking: true, voice: true, atomicity: true, sourceIntegrity: true },
  };
  const result = canPromote(note);
  assert.equal(result.allowed, true);
  assert.equal(result.destination, '5-maps/');
});

test('canPromote keeps synthesis note in 3-permanent when below link-density threshold', () => {
  const note = {
    body: 'Atomic claim with [[one-link]] and [[two-link]] and [[three-link]]. Body has substance and named mechanisms.',
    frontmatter: { source: 'synthesis', tags: ['synthesis'] },
    gateCriteria: { depth: true, sourcing: true, linking: true, voice: true, atomicity: true, sourceIntegrity: true },
  };
  const result = canPromote(note);
  assert.equal(result.allowed, true);
  assert.equal(result.destination, '3-permanent/');
});

test('canPromote does not route to 5-maps for non-synthesis link-dense notes (atomic claims that happen to cite many)', () => {
  const note = {
    body: linkDenseBody(15),
    frontmatter: { source: '[Author](https://example.com)', tags: ['biology'] },
    gateCriteria: { depth: true, sourcing: true, linking: true, voice: true, atomicity: true, sourceIntegrity: true },
  };
  const result = canPromote(note);
  assert.equal(result.allowed, true);
  assert.equal(result.destination, '3-permanent/');
});

test('canPromote does not route to 5-maps when criteria fail (synthesis + dense but shallow)', () => {
  const note = {
    body: linkDenseBody(12),
    frontmatter: { source: 'synthesis', tags: ['synthesis'] },
    gateCriteria: { depth: false, sourcing: true, linking: true, voice: false, atomicity: false, sourceIntegrity: true },
  };
  const result = canPromote(note);
  assert.notEqual(result.destination, '5-maps/');
});

test('canPromote source=discovery + link-dense routes to 5-maps (discovery synthesis hub)', () => {
  const note = {
    body: linkDenseBody(20),
    frontmatter: { source: 'discovery', tags: ['discovery'] },
    gateCriteria: { depth: true, sourcing: true, linking: true, voice: true, atomicity: true, sourceIntegrity: true },
  };
  const result = canPromote(note);
  assert.equal(result.allowed, true);
  assert.equal(result.destination, '5-maps/');
});

test('canPromote markers still block synthesis-hub routing to 5-maps', () => {
  const note = {
    body: `${linkDenseBody(12)} [unresolved] still pending verification.`,
    frontmatter: { source: 'synthesis', tags: ['synthesis'] },
    gateCriteria: { depth: true, sourcing: true, linking: true, voice: true, atomicity: true, sourceIntegrity: true },
  };
  const result = canPromote(note);
  assert.equal(result.allowed, false);
  assert.equal(result.destination, '1-fleeting/');
});

// ---------------------------------------------------------------------------
// 2-literature routing — respect caller, never auto-route here
// ---------------------------------------------------------------------------

test('canPromote does not auto-route any note to 2-literature (caller-only destination)', () => {
  const note = {
    body: 'External source summary with [[link]]. Two more lines.',
    frontmatter: { source: '[Smith, "X" (2024)](https://example.com)', tags: ['literature'] },
    gateCriteria: { depth: true, sourcing: true, linking: true, voice: true, atomicity: true, sourceIntegrity: true },
  };
  const result = canPromote(note);
  assert.notEqual(result.destination, '2-literature/');
});

test('promoteWithVerification respects caller destination 2-literature without verifier invocation', async () => {
  let calls = 0;
  const fakeVerifier = async () => { calls++; return { highSeverityIssues: 0, warnings: [] }; };
  const note = {
    path: 'fake/2-literature/paper.md',
    body: 'Literature note body with [[link]].',
    frontmatter: { source: '[Author](https://example.com)' },
    gateCriteria: { depth: true, sourcing: true, linking: true, voice: true, atomicity: true, sourceIntegrity: true },
    callerDestination: '2-literature/',
  };
  const result = await promoteWithVerification(note, { verifier: fakeVerifier });
  assert.equal(result.allowed, true);
  assert.equal(result.destination, '2-literature/');
  assert.equal(calls, 0);
});

// ---------------------------------------------------------------------------
// Caller destination override semantics for 5-maps
// ---------------------------------------------------------------------------

test('promoteWithVerification respects caller destination 5-maps (skip verifier, link-density not required)', async () => {
  let calls = 0;
  const fakeVerifier = async () => { calls++; return { highSeverityIssues: 0, warnings: [] }; };
  const note = {
    path: 'fake/5-maps/hub.md',
    body: 'Hub note body with [[link]]. Hand-placed map.',
    frontmatter: { tags: ['synthesis'] },
    gateCriteria: { depth: true, sourcing: true, linking: true, voice: true, atomicity: true, sourceIntegrity: true },
    callerDestination: '5-maps/',
  };
  const result = await promoteWithVerification(note, { verifier: fakeVerifier });
  assert.equal(result.allowed, true);
  assert.equal(result.destination, '5-maps/');
  assert.equal(calls, 0);
});

// ---------------------------------------------------------------------------
// Case-insensitive marker matching
// ---------------------------------------------------------------------------

function passingNote(extraBody = '') {
  return {
    body: 'A claim. [[some-link]]' + extraBody,
    frontmatter: { tags: ['x'] },
    gateCriteria: { depth: true, sourcing: true, linking: true, voice: true, atomicity: true, sourceIntegrity: true },
  };
}

test('capitalized verification markers still block promotion', () => {
  const res = canPromote(passingNote('\n[Unverified] claim pending.'));
  assert.equal(res.allowed, false);
  assert.equal(res.destination, '1-fleeting/');
});

test('[needs verification] and [citation needed] block promotion in any case', () => {
  for (const marker of ['[Needs Verification]', '[needs verification]', '[Citation Needed]', '[citation needed]']) {
    const res = canPromote(passingNote(`\n${marker}`));
    assert.equal(res.allowed, false, marker);
  }
});
