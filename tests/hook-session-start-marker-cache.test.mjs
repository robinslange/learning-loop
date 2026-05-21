import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readMarker, MARKER_TTL_MS } from '../scripts/lib/marker-cache.mjs';

test('readMarker returns null when marker is absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-marker-'));
  try {
    assert.equal(readMarker(join(dir, 'missing.json')), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readMarker returns parsed contents when fresh', () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-marker-'));
  try {
    const path = join(dir, 'fresh.json');
    writeFileSync(path, JSON.stringify({ value: 'fresh' }));
    assert.deepEqual(readMarker(path), { value: 'fresh' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readMarker returns null when marker is older than TTL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-marker-'));
  try {
    const path = join(dir, 'stale.json');
    writeFileSync(path, JSON.stringify({ value: 'old' }));
    const old = (Date.now() - MARKER_TTL_MS - 1000) / 1000;
    utimesSync(path, old, old);
    assert.equal(readMarker(path), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readMarker returns null on parse error rather than throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-marker-'));
  try {
    const path = join(dir, 'corrupt.json');
    writeFileSync(path, 'not-json{');
    assert.equal(readMarker(path), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
