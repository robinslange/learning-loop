import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditPostFanout } from '../scripts/ingest-postfanout-audit.mjs';

test('audit passes when 4 docs + METADATA exist', () => {
  const vault = mkdtempSync(join(tmpdir(), 'audit-'));
  try {
    const dir = join(vault, '_ingested-repos/foo-abcdef');
    mkdirSync(dir, { recursive: true });
    for (const f of ['STACK.md', 'ARCH.md', 'CONVENTIONS.md', 'DOMAIN.md', 'METADATA.json']) {
      writeFileSync(join(dir, f), 'x');
    }
    const result = auditPostFanout(vault, 'foo-abcdef', ['stack', 'arch', 'conventions', 'domain']);
    assert.equal(result.ok, true);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.unexpected, []);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('audit reports missing doc when mapper claimed ok but file absent', () => {
  const vault = mkdtempSync(join(tmpdir(), 'audit-miss-'));
  try {
    const dir = join(vault, '_ingested-repos/bar-abcdef');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'STACK.md'), 'x');
    writeFileSync(join(dir, 'METADATA.json'), '{}');

    const result = auditPostFanout(vault, 'bar-abcdef', ['stack', 'arch']);
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing.sort(), ['ARCH.md']);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('audit reports unexpected files', () => {
  const vault = mkdtempSync(join(tmpdir(), 'audit-extra-'));
  try {
    const dir = join(vault, '_ingested-repos/baz-abcdef');
    mkdirSync(dir, { recursive: true });
    for (const f of ['STACK.md', 'ARCH.md', 'CONVENTIONS.md', 'DOMAIN.md', 'METADATA.json', 'ROGUE.md']) {
      writeFileSync(join(dir, f), 'x');
    }
    const result = auditPostFanout(vault, 'baz-abcdef', ['stack', 'arch', 'conventions', 'domain']);
    assert.equal(result.ok, false);
    assert.deepEqual(result.unexpected, ['ROGUE.md']);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('audit reports directory absent when slug dir missing', () => {
  const vault = mkdtempSync(join(tmpdir(), 'audit-nodir-'));
  try {
    const result = auditPostFanout(vault, 'ghost-abcdef', ['stack']);
    assert.equal(result.ok, false);
    assert.match(result.missing[0], /directory absent/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('partial success: one mapper failed (3 of 4 succeeded), expects only 3 docs + METADATA', () => {
  const vault = mkdtempSync(join(tmpdir(), 'audit-partial-'));
  try {
    const dir = join(vault, '_ingested-repos/foo-abcdef');
    mkdirSync(dir, { recursive: true });
    for (const f of ['STACK.md', 'ARCH.md', 'CONVENTIONS.md', 'METADATA.json']) {
      writeFileSync(join(dir, f), 'x');
    }
    const result = auditPostFanout(vault, 'foo-abcdef', ['stack', 'arch', 'conventions']);
    assert.equal(result.ok, true);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.unexpected, []);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});
