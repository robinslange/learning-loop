import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// ygrep's walker excludes paths under /tmp by default. That is os.tmpdir() on
// Linux, but also on any machine where TMPDIR points under /tmp (e.g. the agent
// harness sets TMPDIR=/tmp/claude-<uid>). Anchor fixtures under $HOME whenever
// tmpdir() resolves under /tmp, so the indexer actually walks the fixture.
const fixtureRoot = tmpdir().startsWith('/tmp') ? homedir() : tmpdir();

test('ygrep is callable from spawned process with parent PATH', () => {
  const out = execFileSync('ygrep', ['--version'], { encoding: 'utf-8' });
  assert.match(out, /ygrep \d+\.\d+\.\d+/);
});

test('ygrep index + search round-trip works on a tiny repo', () => {
  const dir = mkdtempSync(join(fixtureRoot, 'ygrep-smoke-'));
  try {
    writeFileSync(join(dir, 'a.ts'), 'export function sendCampaign() {}\n');
    execFileSync('ygrep', ['index', dir], { encoding: 'utf-8' });
    const out = execFileSync('ygrep', ['send', '-C', dir, '--json', '--limit', '5'], { encoding: 'utf-8' });
    assert.match(out, /sendCampaign|a\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
