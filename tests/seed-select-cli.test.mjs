// tests/seed-select-cli.test.mjs
// Roundtrips the seed-select CLI (the surface /seed shells out to): argv
// parsing, the 'feedback' default, comma-split types and deny patterns,
// usage exit. The pure selector is covered in seed-select.test.mjs.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLI = new URL('../scripts/seed-select.mjs', import.meta.url).pathname;
let memDir;

function runCli(args) {
  const out = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 10000 });
  return JSON.parse(out);
}

function mem(name, type) {
  writeFileSync(join(memDir, name), `---\nname: ${name}\ntype: ${type}\n---\nbody\n`);
}

before(() => {
  memDir = mkdtempSync(join(tmpdir(), 'll-seed-cli-'));
  mem('feedback_clean.md', 'feedback');
  mem('feedback_acme_notes.md', 'feedback');
  mem('project_thing.md', 'project');
  mem('reference_link.md', 'reference');
});

after(() => {
  rmSync(memDir, { recursive: true, force: true });
});

test('defaults to type=feedback when no types arg is given', () => {
  const { kept, dropped } = runCli([memDir]);
  assert.deepEqual(kept.sort(), ['feedback_acme_notes.md', 'feedback_clean.md']);
  assert.equal(dropped.length, 2);
  assert.ok(dropped.every((d) => d.reason === 'type-excluded'));
});

test('comma-split types arg widens the selection', () => {
  const { kept } = runCli([memDir, 'feedback,project']);
  assert.deepEqual(kept.sort(), ['feedback_acme_notes.md', 'feedback_clean.md', 'project_thing.md']);
});

test('comma-split deny arg drops on word-boundary name match', () => {
  const { kept, dropped } = runCli([memDir, 'feedback', 'acme,unused-term']);
  assert.deepEqual(kept, ['feedback_clean.md']);
  const denied = dropped.find((d) => d.name === 'feedback_acme_notes.md');
  assert.equal(denied.reason, 'name-denied');
});

test('whitespace around commas is tolerated', () => {
  const { kept } = runCli([memDir, ' feedback , project ']);
  assert.deepEqual(kept.sort(), ['feedback_acme_notes.md', 'feedback_clean.md', 'project_thing.md']);
});

test('missing memDir exits 2 with usage on stderr', () => {
  try {
    execFileSync(process.execPath, [CLI], { encoding: 'utf8', timeout: 10000 });
    assert.fail('expected non-zero exit');
  } catch (err) {
    assert.equal(err.status, 2);
    assert.match(String(err.stderr), /Usage: seed-select\.mjs/);
  }
});
