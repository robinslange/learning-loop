import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// ygrep's walker excludes paths under /tmp by default. That is os.tmpdir() on
// Linux, but also on any machine where TMPDIR points under /tmp (e.g. the agent
// harness sets TMPDIR=/tmp/claude-<uid>). Anchor fixtures under $HOME whenever
// tmpdir() resolves under /tmp, so the indexer actually walks the fixture.
const fixtureRoot = tmpdir().startsWith('/tmp') ? homedir() : tmpdir();

function ygrepAvailable() {
  try {
    execFileSync('ygrep', ['--version'], { encoding: 'utf-8', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
const SKIP = ygrepAvailable() ? false : 'ygrep binary not on PATH';

test('ygrep is callable from spawned process with parent PATH', { skip: SKIP }, () => {
  const out = execFileSync('ygrep', ['--version'], { encoding: 'utf-8' });
  assert.match(out, /ygrep \d+\.\d+\.\d+/);
});

test('ygrep index + search round-trip works on a tiny repo', { skip: SKIP }, () => {
  const dir = mkdtempSync(join(fixtureRoot, 'ygrep-smoke-'));
  let indexHash = null;
  try {
    writeFileSync(join(dir, 'a.ts'), 'export function sendCampaign() {}\n');
    // ygrep prints its progress (including "Index stored at: .../<hash>") to
    // stderr — capture both streams to keep the hash for cleanup.
    const indexRun = spawnSync('ygrep', ['index', dir], { encoding: 'utf-8' });
    assert.equal(indexRun.status, 0, indexRun.stderr);
    indexHash =
      `${indexRun.stdout}\n${indexRun.stderr}`.match(/Index stored at:.*[/\\]([0-9a-f]{16})\s*$/m)?.[1] ?? null;
    assert.ok(indexHash, 'index hash must be parseable for cleanup');
    const out = execFileSync('ygrep', ['send', '-C', dir, '--json', '--limit', '5'], { encoding: 'utf-8' });
    assert.match(out, /sendCampaign|a\.ts/);
  } finally {
    // ygrep has no index-store override, so drop the index it created for the
    // fixture workspace — otherwise every run deposits an orphan in the real
    // store (~/Library/Application Support/ygrep/indexes). Remove by hash:
    // remove-by-path leaves the index dir behind on this ygrep build.
    if (indexHash) {
      try {
        execFileSync('ygrep', ['indexes', 'remove', indexHash], { encoding: 'utf-8', timeout: 5000 });
      } catch {
        // Best-effort: an orphaned index is exactly what `ygrep indexes clean` exists for.
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
