// tests/provenance-vocabulary.test.mjs
// Emit-boundary validation: provenance.mjs must reject actions outside the
// committed vocabulary, while readers must still accept legacy spellings.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  VALID_ACTIONS,
  LEGACY_ACTIONS,
  isKnownAction,
  INTENT_KINDS,
} from '../plugin/scripts/lib/provenance-vocabulary.mjs';

const PROVENANCE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'plugin',
  'scripts',
  'provenance.mjs',
);

function readEvents(root) {
  const dir = join(root, 'provenance');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith('events-') && f.endsWith('.jsonl'))
    .flatMap((f) =>
      readFileSync(join(dir, f), 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    );
}

function emit(event, root) {
  return spawnSync('node', [PROVENANCE, JSON.stringify(event)], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: root },
    encoding: 'utf-8',
  });
}

test('a valid action emits successfully', () => {
  const root = mkdtempSync(join(tmpdir(), 'll-prov-vocab-'));
  try {
    const result = emit({ agent: 'test', action: 'create', target: 'x.md' }, root);
    assert.strictEqual(result.status, 0, `unexpected exit: ${result.stderr}`);
    const events = readEvents(root);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].action, 'create');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a legacy action is rejected for emit but isKnownAction returns true', () => {
  assert.ok(LEGACY_ACTIONS.has('write-note'));
  assert.ok(isKnownAction('write-note'));
  assert.ok(!VALID_ACTIONS.has('write-note'));

  const root = mkdtempSync(join(tmpdir(), 'll-prov-vocab-'));
  try {
    const result = emit({ agent: 'test', action: 'write-note', target: 'x.md' }, root);
    assert.strictEqual(result.status, 0, `rejection must not crash the CLI: ${result.stderr}`);
    assert.strictEqual(readEvents(root).length, 0, 'legacy action must not be written');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unknown/garbage action is rejected and does not write', () => {
  assert.ok(!isKnownAction('totally-made-up-action'));

  const root = mkdtempSync(join(tmpdir(), 'll-prov-vocab-'));
  try {
    const result = emit({ agent: 'test', action: 'totally-made-up-action', target: 'x.md' }, root);
    assert.strictEqual(result.status, 0, `rejection must not crash the CLI: ${result.stderr}`);
    assert.strictEqual(readEvents(root).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing action is rejected', () => {
  const root = mkdtempSync(join(tmpdir(), 'll-prov-vocab-'));
  try {
    const result = emit({ agent: 'test', target: 'x.md' }, root);
    assert.strictEqual(result.status, 0, `rejection must not crash the CLI: ${result.stderr}`);
    assert.strictEqual(readEvents(root).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejection logs rather than throws, and nothing was appended', () => {
  const root = mkdtempSync(join(tmpdir(), 'll-prov-vocab-'));
  try {
    const result = emit({ agent: 'test', action: 'bogus' }, root);
    // The CLI wrapper only exits non-zero on a thrown exception (see the
    // try/catch around emitProvenance in provenance.mjs); a clean exit 0
    // here proves the rejection returned rather than throwing.
    assert.strictEqual(result.status, 0);
    assert.match(result.stderr, /provenance\.invalidAction/);
    assert.strictEqual(readEvents(root).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('VALID_ACTIONS and LEGACY_ACTIONS are disjoint', () => {
  for (const a of LEGACY_ACTIONS) {
    assert.ok(!VALID_ACTIONS.has(a), `${a} must not be in both sets`);
  }
});

test('a bounded intent_kind emits and is kept on the record', () => {
  const root = mkdtempSync(join(tmpdir(), 'll-prov-vocab-'));
  try {
    const result = emit({ agent: 'test', action: 'session-start', intent_kind: 'scope' }, root);
    assert.strictEqual(result.status, 0, `unexpected exit: ${result.stderr}`);
    const events = readEvents(root);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].intent_kind, 'scope');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('free-text intent is dropped, not the whole event', () => {
  const root = mkdtempSync(join(tmpdir(), 'll-prov-vocab-'));
  try {
    const result = emit(
      { agent: 'test', action: 'session-start', intent: 'OPA for schema-driven authorisation' },
      root,
    );
    assert.strictEqual(result.status, 0, `unexpected exit: ${result.stderr}`);
    assert.match(result.stderr, /provenance\.freeTextIntent/);
    const events = readEvents(root);
    assert.strictEqual(events.length, 1, 'the rest of the record must still be written');
    assert.strictEqual(events[0].agent, 'test');
    assert.ok(!('intent' in events[0]), 'free-text intent must not survive onto the record');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unbounded intent_kind is dropped like free-text intent', () => {
  const root = mkdtempSync(join(tmpdir(), 'll-prov-vocab-'));
  try {
    const result = emit(
      { agent: 'test', action: 'session-start', intent_kind: 'not-a-real-kind' },
      root,
    );
    assert.strictEqual(result.status, 0);
    assert.match(result.stderr, /provenance\.freeTextIntent/);
    const events = readEvents(root);
    assert.strictEqual(events.length, 1);
    assert.ok(!('intent_kind' in events[0]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('INTENT_KINDS is small and closed', () => {
  assert.ok(INTENT_KINDS.size <= 10, 'intent_kind must stay a small closed vocabulary');
  assert.ok(INTENT_KINDS.has('scope'));
  assert.ok(INTENT_KINDS.has('topic'));
});
