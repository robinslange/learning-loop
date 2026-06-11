import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readMarker, writeMarker, MARKER_TTL_MS } from '../plugin/scripts/lib/marker-cache.mjs';

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

test('writeMarker creates intermediate directories', () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-marker-'));
  try {
    const path = join(dir, 'nested', 'deep', 'marker.json');
    assert.equal(writeMarker(path, { hello: 'world' }), true, 'persisted write returns true');
    assert.deepEqual(readMarker(path), { hello: 'world' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeMarker overwrites existing markers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'll-marker-'));
  try {
    const path = join(dir, 'overwrite.json');
    writeMarker(path, { v: 1 });
    writeMarker(path, { v: 2 });
    assert.deepEqual(readMarker(path), { v: 2 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeMarker swallows errors when target is unwritable', () => {
  // Use a path under a non-existent unwritable parent: trying to mkdir inside
  // a file (not a directory) will throw ENOTDIR.
  const dir = mkdtempSync(join(tmpdir(), 'll-marker-'));
  try {
    const blocker = join(dir, 'is-a-file');
    writeFileSync(blocker, 'content');
    // writeMarker tries to mkdir(dirname(badPath)) where dirname is `is-a-file` — fails.
    const badPath = join(blocker, 'cannot-create.json');
    // Must not throw — and must report the failure via its return value.
    assert.equal(writeMarker(badPath, { x: 1 }), false, 'failed write returns false');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
