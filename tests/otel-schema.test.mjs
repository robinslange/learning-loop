import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXPORT_SCHEMA, NEVER_EXPORT, validateExportRecord } from '../plugin/scripts/otel/schema.mjs';
import { enumerateTelemetryKeys } from '../plugin/scripts/otel/enumerate-keys.mjs';

test('a record with only allowlisted fields passes', () => {
  assert.doesNotThrow(() => {
    validateExportRecord('provenance', { action: 'vault-write', session_id: 'abc-123', folder: 'permanent' });
  });
});

test('a record carrying an unlisted field throws', () => {
  assert.throws(() => {
    validateExportRecord('provenance', { action: 'vault-write', target: '/Users/robin/vault/note.md' });
  }, /target/);
});

test('every field in NEVER_EXPORT is rejected if present, in every stream', () => {
  for (const stream of Object.keys(EXPORT_SCHEMA)) {
    for (const field of NEVER_EXPORT) {
      assert.throws(
        () => validateExportRecord(stream, { [field]: 'anything' }),
        new RegExp(field),
        `expected ${stream} to reject ${field}`
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
