// Integration test: collect -> scrub pipeline (IP-leak path).
// Runs the REAL CLI scripts end-to-end in a temp vault.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const collectScript = fileURLToPath(
  new URL('../plugin/scripts/harvest-collect.mjs', import.meta.url),
);
const scrubScript = fileURLToPath(new URL('../plugin/scripts/harvest-scrub.mjs', import.meta.url));

test('collect -> scrub: portable+deny note is blocked; non-portable never reaches scrub', () => {
  const root = mkdtempSync(join(tmpdir(), 'll-pipeline-'));
  try {
    const vaultDir = join(root, 'vault');
    const memDir = join(root, 'mem');
    mkdirSync(vaultDir);
    mkdirSync(memDir);

    // keep.md: portable, innocuous -> should pass collect and scrub -> clean
    writeFileSync(
      join(vaultDir, 'keep.md'),
      '---\nportable: true\n---\nA generic retry lesson about exponential backoff.',
    );

    // secret.md: portable but contains the deny term -> should pass collect, get blocked by scrub
    writeFileSync(
      join(vaultDir, 'secret.md'),
      '---\nportable: true\n---\nWe use acmecorp for client work. This must not leak.',
    );

    // private.md: no portable key, contains nothing sensitive -> must NOT appear anywhere in scrub output
    writeFileSync(join(vaultDir, 'private.md'), '---\n---\nInternal note with no portable flag.');

    const denyFile = join(root, 'deny.txt');
    writeFileSync(denyFile, 'acmecorp\n');

    // Step 1: collect
    const collectOut = execFileSync(process.execPath, [collectScript, vaultDir, memDir], {
      encoding: 'utf8',
    });
    const keptPaths = collectOut
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);

    // Collect should return keep.md and secret.md, not private.md
    assert.ok(
      keptPaths.some((p) => p.endsWith('keep.md')),
      'keep.md (portable:true) must be kept by collect',
    );
    assert.ok(
      keptPaths.some((p) => p.endsWith('secret.md')),
      'secret.md (portable:true) must be kept by collect',
    );
    assert.ok(
      !keptPaths.some((p) => p.endsWith('private.md')),
      'private.md (no portable key) must NOT be kept by collect',
    );

    // Step 2: pipe collect output into scrub via stdin
    const scrubOut = execFileSync(
      process.execPath,
      [scrubScript, denyFile, ''], // empty pluginData => no derived instance facts
      { input: collectOut, encoding: 'utf8' },
    );
    const result = JSON.parse(scrubOut);

    // KEY IP-SAFETY ASSERTION: portable+deny note must be blocked
    assert.ok(
      result.blocked.some((b) => b.path.endsWith('secret.md')),
      'secret.md (portable:true + deny term) must be BLOCKED by scrub — key IP-leak assertion',
    );

    // The clean portable note must be in clean
    assert.ok(
      result.clean.some((c) => c.path.endsWith('keep.md')),
      'keep.md (portable:true, no deny hits) must be in clean',
    );

    // The non-portable note must never appear anywhere in the scrub output
    const allScrubPaths = [
      ...result.blocked.map((b) => b.path),
      ...result.tripwire.map((t) => t.path),
      ...result.clean.map((c) => c.path),
    ];
    assert.ok(
      !allScrubPaths.some((p) => p.endsWith('private.md')),
      'private.md (non-portable) must not appear anywhere in scrub output',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
