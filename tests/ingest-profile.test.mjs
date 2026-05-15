import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateProfile } from '../scripts/ingest-profile.mjs';

test('generates profile for a tiny TS repo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'profile-'));
  try {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/index.ts'), 'export const x = 1;\n');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'tiny', version: '0.1.0',
      dependencies: { next: '15.0.0', react: '19.0.0' },
    }));

    const profile = generateProfile(dir);

    assert.equal(profile.name, 'tiny');
    assert.ok(profile.languages.ts >= 1);
    assert.ok(profile.dependencies_count >= 2);
    assert.deepEqual(profile.frameworks_detected.sort(), ['next', 'react']);
    assert.equal(profile.file_count, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('detects monorepo signal via workspaces field', () => {
  const dir = mkdtempSync(join(tmpdir(), 'profile-mono-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'mono', workspaces: ['packages/*'],
    }));
    mkdirSync(join(dir, 'packages'));

    const profile = generateProfile(dir);
    assert.equal(profile.has_workspaces, true);
    assert.equal(profile.has_monorepo_signal, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('falls back gracefully when no manifest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'profile-bare-'));
  try {
    writeFileSync(join(dir, 'main.go'), 'package main\nfunc main() {}\n');
    const profile = generateProfile(dir);
    assert.ok(profile.languages.go >= 1);
    assert.equal(profile.dependencies_count, 0);
    assert.deepEqual(profile.frameworks_detected, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
