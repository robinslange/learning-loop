import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from '../plugin/scripts/lib/write-atomic.mjs';

const HELPER = new URL('../plugin/scripts/lib/write-atomic.mjs', import.meta.url).href;

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'll-write-atomic-'));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

// Each writer's payload is one repeated character, so a torn or interleaved
// file shows up as more than one distinct character or a short length.
const SIZE = 256 * 1024;
const WRITES = 20;

function writer(target, ch, home) {
  const code = `
    const { writeFileAtomic } = await import(${JSON.stringify(HELPER)});
    for (let i = 0; i < ${WRITES}; i++) writeFileAtomic(${JSON.stringify(target)}, ${JSON.stringify(ch)}.repeat(${SIZE}));
  `;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        USERPROFILE: home,
        CLAUDE_PLUGIN_DATA: join(home, 'pd'),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

function assertWhole(text) {
  assert.equal(text.length, SIZE, 'target holds one complete payload');
  assert.equal(new Set(text).size, 1, 'target holds exactly one writer’s payload');
}

test('concurrent writers on one path each finish, and readers never see a torn file', () =>
  withTempDir(async (dir) => {
    const target = join(dir, 'state.json');
    const home = join(dir, 'home');
    mkdirSync(home);
    writeFileSync(target, 'x'.repeat(SIZE));

    let done = false;
    let reads = 0;
    const reader = (async () => {
      while (!done) {
        assertWhole(readFileSync(target, 'utf8'));
        reads++;
        await new Promise((r) => setImmediate(r));
      }
    })();

    const results = await Promise.all(['a', 'b', 'c', 'd'].map((ch) => writer(target, ch, home)));
    done = true;
    await reader;

    for (const r of results) assert.equal(r.code, 0, r.stderr);
    assert.ok(reads > 0);
    assertWhole(readFileSync(target, 'utf8'));
    assert.deepEqual(
      readdirSync(dir).filter((n) => n.endsWith('.tmp')),
      [],
      'no tmp file left behind',
    );
  }));

test('a failed rename leaves the target unchanged and no tmp file behind', () =>
  withTempDir((dir) => {
    // A non-empty directory can't be replaced by a file on any platform, so
    // the tmp file is written and the rename throws.
    const target = join(dir, 'occupied');
    mkdirSync(target);
    writeFileSync(join(target, 'keep'), 'kept');

    assert.throws(() => writeFileAtomic(target, 'new'));

    assert.equal(readFileSync(join(target, 'keep'), 'utf8'), 'kept');
    assert.deepEqual(readdirSync(dir), ['occupied']);
  }));

test('a failed write into a missing directory throws and creates nothing', () =>
  withTempDir((dir) => {
    assert.throws(() => writeFileAtomic(join(dir, 'missing', 'f.json'), '{}'), { code: 'ENOENT' });
    assert.deepEqual(readdirSync(dir), []);
  }));
