import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

const HOOK = join(import.meta.dirname, '..', 'hooks', 'dream-gate.js');
const tmp = tmpdir();
const DREAM_MARKER = join(tmp, 'learning-loop-last-dream');
const DREAM_LOCK = join(tmp, 'learning-loop-dream-lock');

const FAKE_PROJECT_DIR = '/tmp/ll-test-dream-project';
const encodedPath = FAKE_PROJECT_DIR.replace(/[/\\]/g, '-');
const home = process.env.HOME || process.env.USERPROFILE || homedir();
const memoryDir = join(home, '.claude', 'projects', encodedPath, 'memory');

function run() {
  return execFileSync('node', [HOOK], {
    encoding: 'utf-8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: FAKE_PROJECT_DIR },
    timeout: 5000,
  });
}

function saveTmpFile(path) {
  if (existsSync(path)) return readFileSync(path);
  return null;
}

function restoreTmpFile(path, data) {
  if (data !== null) writeFileSync(path, data);
  else rmSync(path, { force: true });
}

describe('dream-gate', () => {
  let savedMarker;
  let savedLock;

  before(() => {
    savedMarker = saveTmpFile(DREAM_MARKER);
    savedLock = saveTmpFile(DREAM_LOCK);

    mkdirSync(memoryDir, { recursive: true });
  });

  after(() => {
    restoreTmpFile(DREAM_MARKER, savedMarker);
    restoreTmpFile(DREAM_LOCK, savedLock);

    rmSync(memoryDir, { recursive: true, force: true });
  });

  it('exits silently when lock file exists', () => {
    writeFileSync(DREAM_LOCK, '1');
    rmSync(DREAM_MARKER, { force: true });
    try {
      const out = run();
      assert.equal(out, '');
    } finally {
      rmSync(DREAM_LOCK, { force: true });
    }
  });

  it('creates marker and exits on first run (no existing marker)', () => {
    rmSync(DREAM_LOCK, { force: true });
    rmSync(DREAM_MARKER, { force: true });

    const out = run();
    assert.equal(out, '');
    assert.ok(existsSync(DREAM_MARKER), 'marker should be created');

    const ts = parseInt(readFileSync(DREAM_MARKER, 'utf8').trim(), 10);
    const nowSec = Math.floor(Date.now() / 1000);
    assert.ok(Math.abs(nowSec - ts) < 5, 'marker timestamp should be close to now');
  });

  it('exits silently when last dream was less than 24h ago', () => {
    rmSync(DREAM_LOCK, { force: true });
    const recentTs = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
    writeFileSync(DREAM_MARKER, String(recentTs));

    const out = run();
    assert.equal(out, '');
  });

  it('exits silently when fewer than 5 files modified since last dream', () => {
    rmSync(DREAM_LOCK, { force: true });
    const oldTs = Math.floor(Date.now() / 1000) - 90000; // 25 hours ago
    writeFileSync(DREAM_MARKER, String(oldTs));

    // Clear memory dir and add only 3 recently modified files
    rmSync(memoryDir, { recursive: true, force: true });
    mkdirSync(memoryDir, { recursive: true });

    const futureTime = new Date((oldTs + 1000) * 1000);
    for (let i = 0; i < 3; i++) {
      const f = join(memoryDir, `note-${i}.md`);
      writeFileSync(f, 'content');
      utimesSync(f, futureTime, futureTime);
    }

    const out = run();
    assert.equal(out, '');
  });

  it('outputs nudge when both gates pass (24h elapsed + 5+ modified files)', () => {
    rmSync(DREAM_LOCK, { force: true });
    const oldTs = Math.floor(Date.now() / 1000) - 90000; // 25 hours ago
    writeFileSync(DREAM_MARKER, String(oldTs));

    rmSync(memoryDir, { recursive: true, force: true });
    mkdirSync(memoryDir, { recursive: true });

    const futureTime = new Date((oldTs + 1000) * 1000);
    for (let i = 0; i < 7; i++) {
      const f = join(memoryDir, `note-${i}.md`);
      writeFileSync(f, 'content');
      utimesSync(f, futureTime, futureTime);
    }

    const out = run();
    assert.match(out, /7 files modified/);
    assert.match(out, /Run \/dream to consolidate/);
  });
});
