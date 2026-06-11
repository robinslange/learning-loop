import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, utimesSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

const HOOK = join(import.meta.dirname, '..', 'hooks', 'lib', 'dream-gate.js');
const tmp = tmpdir();

const PLUGIN_DATA = mkdtempSync(join(tmp, 'll-test-dream-plugin-data-'));
const DREAM_MARKER = join(PLUGIN_DATA, 'retrieval', 'last-dream');
const DREAM_LOCK = join(PLUGIN_DATA, 'markers', 'dream-lock');

const FAKE_PROJECT_DIR = join(tmp, 'll-test-dream-project');
const encodedPath = FAKE_PROJECT_DIR.replace(/[/\\]/g, '-');
const home = process.env.HOME || process.env.USERPROFILE || homedir();
const memoryDir = join(home, '.claude', 'projects', encodedPath, 'memory');

function run() {
  return execFileSync('node', [HOOK], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: FAKE_PROJECT_DIR,
      CLAUDE_PLUGIN_DATA: PLUGIN_DATA,
    },
    timeout: 5000,
  });
}

describe('dream-gate', () => {
  before(() => {
    mkdirSync(join(PLUGIN_DATA, 'retrieval'), { recursive: true });
    mkdirSync(join(PLUGIN_DATA, 'markers'), { recursive: true });
    mkdirSync(memoryDir, { recursive: true });
  });

  beforeEach(() => {
    rmSync(DREAM_LOCK, { force: true });
  });

  after(() => {
    rmSync(PLUGIN_DATA, { recursive: true, force: true });
    rmSync(memoryDir, { recursive: true, force: true });
  });

  it('exits silently when lock file exists', () => {
    writeFileSync(DREAM_LOCK, '1');
    rmSync(DREAM_MARKER, { force: true });
    const out = run();
    assert.equal(out, '');
  });

  it('creates marker and exits on first run (no existing marker)', () => {
    rmSync(DREAM_MARKER, { force: true });

    const out = run();
    assert.equal(out, '');
    assert.ok(existsSync(DREAM_MARKER), 'marker should be created');

    const ts = parseInt(readFileSync(DREAM_MARKER, 'utf8').trim(), 10);
    const nowSec = Math.floor(Date.now() / 1000);
    assert.ok(Math.abs(nowSec - ts) < 5, 'marker timestamp should be close to now');
  });

  it('exits silently when last dream was less than 24h ago', () => {
    const recentTs = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
    writeFileSync(DREAM_MARKER, String(recentTs));

    const out = run();
    assert.equal(out, '');
  });

  it('exits silently when fewer than 5 files modified since last dream', () => {
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

  it('stale lock (old mtime, dead pid) does not silence the gate — M5', () => {
    writeFileSync(DREAM_LOCK, '2147483647');
    const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    utimesSync(DREAM_LOCK, old, old);
    rmSync(DREAM_MARKER, { force: true });
    run();
    assert.ok(existsSync(DREAM_MARKER), 'gate must proceed past a stale lock');
  });

  it('fresh lock blocks the gate', () => {
    writeFileSync(DREAM_LOCK, JSON.stringify({ ts: Math.floor(Date.now() / 1000) }));
    rmSync(DREAM_MARKER, { force: true });
    run();
    assert.ok(!existsSync(DREAM_MARKER), 'fresh lock must keep the gate silent');
  });

  it('a last-dream stamp written by marker.mjs suppresses the 24h gate — M1', () => {
    const CLI = join(import.meta.dirname, '..', 'scripts', 'marker.mjs');
    rmSync(DREAM_MARKER, { force: true });
    const stampedPath = execFileSync('node', [CLI, 'stamp', 'last-dream'], {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: PLUGIN_DATA },
    }).toString().trim();
    assert.equal(stampedPath, DREAM_MARKER, 'stamp must land where the gate reads');
    assert.ok(existsSync(DREAM_MARKER), 'stamp must exist before the gate runs');
    const out = run();
    assert.equal(out.trim(), '', 'fresh dream stamp → no nudge');
  });
});
