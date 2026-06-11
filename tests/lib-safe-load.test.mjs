import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeLoad } from '../plugin/scripts/lib/safe-load.mjs';

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'll-safeload-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('empty path returns fallback with error="no path"', () => {
  const { value, error } = safeLoad('');
  assert.equal(value, null);
  assert.equal(error, 'no path');
});

test('null path returns fallback with error="no path"', () => {
  const { value, error } = safeLoad(null);
  assert.equal(value, null);
  assert.equal(error, 'no path');
});

test('missing file returns fallback with error="enoent"', () => {
  const { value, error } = safeLoad('/nonexistent/path.json', { fallback: { a: 1 } });
  assert.deepEqual(value, { a: 1 });
  assert.equal(error, 'enoent');
});

test('happy path: returns parsed value without error', () => {
  withTempDir((d) => {
    const p = join(d, 'ok.json');
    writeFileSync(p, JSON.stringify({ x: 42 }));
    const r = safeLoad(p);
    assert.deepEqual(r.value, { x: 42 });
    assert.equal(r.error, undefined);
  });
});

test('BOM-prefixed JSON is parsed correctly', () => {
  withTempDir((d) => {
    const p = join(d, 'bom.json');
    writeFileSync(p, '﻿' + JSON.stringify({ x: 1 }));
    const r = safeLoad(p);
    assert.deepEqual(r.value, { x: 1 });
    assert.equal(r.error, undefined);
  });
});

test('malformed JSON returns fallback with parse error', () => {
  withTempDir((d) => {
    const p = join(d, 'bad.json');
    writeFileSync(p, '{ not json');
    const r = safeLoad(p, { fallback: [] });
    assert.deepEqual(r.value, []);
    assert.match(r.error, /^parse:/);
  });
});

test('schema rejects invalid value', () => {
  withTempDir((d) => {
    const p = join(d, 'schema-fail.json');
    writeFileSync(p, JSON.stringify({ a: 1 }));
    const r = safeLoad(p, {
      schema: (v) => (typeof v === 'object' && 'b' in v ? true : 'missing b'),
    });
    assert.equal(r.value, null);
    assert.match(r.error, /^schema: missing b/);
  });
});

test('schema accepts valid value', () => {
  withTempDir((d) => {
    const p = join(d, 'schema-ok.json');
    writeFileSync(p, JSON.stringify({ b: 'hi' }));
    const r = safeLoad(p, { schema: (v) => ('b' in v ? true : 'no b') });
    assert.deepEqual(r.value, { b: 'hi' });
    assert.equal(r.error, undefined);
  });
});

test('schema that throws is converted to error string', () => {
  withTempDir((d) => {
    const p = join(d, 'schema-throws.json');
    writeFileSync(p, JSON.stringify({}));
    const r = safeLoad(p, {
      schema: () => {
        throw new Error('explode');
      },
    });
    assert.equal(r.value, null);
    assert.match(r.error, /^schema-threw: explode/);
  });
});

test('custom fallback value is returned on enoent', () => {
  const r = safeLoad('/no/such/file.json', { fallback: 'MISSING' });
  assert.equal(r.value, 'MISSING');
});

test('custom fallback of false is returned on error', () => {
  const r = safeLoad('', { fallback: false });
  assert.equal(r.value, false);
});

test('default fallback is null when opts.fallback not set', () => {
  const r = safeLoad('/no/such/file.json');
  assert.equal(r.value, null);
});

test('returns empty object when file contains {}', () => {
  withTempDir((d) => {
    const p = join(d, 'empty-obj.json');
    writeFileSync(p, '{}');
    const r = safeLoad(p);
    assert.deepEqual(r.value, {});
    assert.equal(r.error, undefined);
  });
});
