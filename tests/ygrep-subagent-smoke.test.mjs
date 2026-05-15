import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('ygrep is callable from spawned process with parent PATH', () => {
  const out = execFileSync('ygrep', ['--version'], { encoding: 'utf-8' });
  assert.match(out, /ygrep \d+\.\d+\.\d+/);
});

test('ygrep index + search round-trip works on a tiny repo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ygrep-smoke-'));
  try {
    writeFileSync(join(dir, 'a.ts'), 'export function sendCampaign() {}\n');
    execFileSync('ygrep', ['index', dir], { encoding: 'utf-8' });
    const out = execFileSync('ygrep', ['send', '-C', dir, '--json', '--limit', '5'], { encoding: 'utf-8' });
    assert.match(out, /sendCampaign|a\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
