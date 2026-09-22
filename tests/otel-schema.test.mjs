import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EXPORT_SCHEMA,
  NEVER_EXPORT,
  LABEL_VALUE_RE,
  validateExportRecord,
} from '../plugin/scripts/otel/schema.mjs';
import { enumerateTelemetryKeys } from '../plugin/scripts/otel/enumerate-keys.mjs';

test('a record with only allowlisted fields passes', () => {
  assert.doesNotThrow(() => {
    validateExportRecord('provenance', {
      action: 'vault-write',
      session_id: 'abc-123',
      folder: 'permanent',
    });
  });
});

test('a record carrying an unlisted field throws', () => {
  assert.throws(() => {
    validateExportRecord('provenance', {
      action: 'vault-write',
      target: '/Users/robin/vault/note.md',
    });
  }, /target/);
});

test('every field in NEVER_EXPORT is rejected if present, in every stream', () => {
  for (const stream of Object.keys(EXPORT_SCHEMA)) {
    for (const field of NEVER_EXPORT) {
      assert.throws(
        () => validateExportRecord(stream, { [field]: 'anything' }),
        new RegExp(field),
        `expected ${stream} to reject ${field}`,
      );
    }
  }
});

test('the enumerator no-ops on a missing plugin-data dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-otel-enum-'));
  try {
    const missing = join(dir, 'does-not-exist');
    assert.doesNotThrow(() => {
      const result = enumerateTelemetryKeys(missing);
      assert.deepStrictEqual(result, {});
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('EXPORT_SCHEMA contains no field that is also in NEVER_EXPORT', () => {
  for (const [stream, fields] of Object.entries(EXPORT_SCHEMA)) {
    for (const field of Object.keys(fields)) {
      assert.ok(!NEVER_EXPORT.has(field), `${stream}.${field} is also in NEVER_EXPORT`);
    }
  }
});

// An adversarial review asked whether the ~136 keys in neither EXPORT_SCHEMA
// nor NEVER_EXPORT could leak. They cannot: absence from a stream's schema is
// itself a refusal. Asserted with fields sampled from the real unclassified
// set, so the guarantee does not rest on NEVER_EXPORT being exhaustive.
test('a field in neither EXPORT_SCHEMA nor NEVER_EXPORT is still refused', () => {
  const unclassified = [
    'notes_checked',
    'sources_passed',
    'promoted_fleeting',
    'note_path',
    'payload',
    'how',
  ];
  for (const field of unclassified) {
    assert.ok(!NEVER_EXPORT.has(field), `${field} must be unlisted for this test to mean anything`);
    for (const stream of Object.keys(EXPORT_SCHEMA)) {
      assert.throws(
        () => validateExportRecord(stream, { [field]: 'whatever' }),
        /is not in the export schema/,
        `${field} must be refused on ${stream} despite being unlisted`,
      );
    }
  }
});

test('a label value that is not identifier shaped throws even when its key is allowlisted', () => {
  for (const value of [
    'refactor the billing module for acme corp',
    '/Users/robin/vault/note.md',
    'https://example.com/x',
    'a'.repeat(129),
    '',
  ]) {
    assert.throws(() => validateExportRecord('provenance', { agent: value }), /identifier shaped/);
  }
});

test('LABEL_VALUE_RE admits every label shape the corpus actually produces', () => {
  for (const value of [
    'general-purpose',
    'learning-loop:_skills:extract-insights',
    'pre-write-check.checkDuplicateNote',
    '174bc571-aa4b-4a52-936e-d34bb634da73',
    'gate-fail-below-threshold',
    '2.1.0',
    'false',
    'global.anthropic.claude-opus-5[1m]',
  ]) {
    assert.ok(LABEL_VALUE_RE.test(value), value);
  }
});
