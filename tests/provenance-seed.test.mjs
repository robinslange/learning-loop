import { test } from 'node:test';
import assert from 'node:assert';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugin');
const PROVENANCE = join(PLUGIN, 'scripts', 'provenance.mjs');

test('emitProvenance seeds both templates from inside plugin/ into PLUGIN_DATA/provenance', () => {
  const root = mkdtempSync(join(tmpdir(), 'll-prov-seed-'));
  try {
    const result = spawnSync(
      'node',
      [PROVENANCE, JSON.stringify({ agent: 'test', action: 'create', target: 'x.md' })],
      { env: { ...process.env, CLAUDE_PLUGIN_DATA: root }, encoding: 'utf-8' },
    );
    assert.strictEqual(
      result.status,
      0,
      `provenance.mjs exited ${result.status}: ${result.stderr}`,
    );

    for (const name of ['learned-patterns.md', 'retired-patterns.md']) {
      const seeded = join(root, 'provenance', name);
      assert.ok(existsSync(seeded), `${name} not seeded into PLUGIN_DATA/provenance`);
      const template = join(PLUGIN, 'provenance', name);
      assert.ok(existsSync(template), `template ${name} missing from plugin/provenance`);
      assert.ok(statSync(seeded).size > 0, `${name} seeded empty`);
      assert.strictEqual(readFileSync(seeded, 'utf-8'), readFileSync(template, 'utf-8'));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI emits when invoked through a symlink (Node realpaths the ESM entry, argv[1] stays the link)', () => {
  const root = mkdtempSync(join(tmpdir(), 'll-prov-symlink-'));
  try {
    const link = join(root, 'prov-link.mjs');
    symlinkSync(PROVENANCE, link);
    const result = spawnSync(
      'node',
      [link, JSON.stringify({ agent: 'test', action: 'create', target: 'sym.md' })],
      { env: { ...process.env, CLAUDE_PLUGIN_DATA: root }, encoding: 'utf-8' },
    );
    assert.strictEqual(
      result.status,
      0,
      `provenance.mjs exited ${result.status}: ${result.stderr}`,
    );

    const dir = join(root, 'provenance');
    const events = (existsSync(dir) ? readdirSync(dir) : [])
      .filter((f) => f.startsWith('events-') && f.endsWith('.jsonl'))
      .flatMap((f) =>
        readFileSync(join(dir, f), 'utf-8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l)),
      );
    assert.strictEqual(events.length, 1, 'symlinked invocation must still emit the event');
    assert.strictEqual(events[0].target, 'sym.md');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
