import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canPromote, promoteWithVerification } from '../scripts/promotion-gate.mjs';

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
