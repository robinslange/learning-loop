import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'release.sh');

function runWithGitStub(stubBody, args = ['patch']) {
  const dir = mkdtempSync(join(tmpdir(), 'll-rel-'));
  const stub = join(dir, 'git');
  writeFileSync(stub, `#!/usr/bin/env bash\n${stubBody}\n`);
  chmodSync(stub, 0o755);
  return spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
}

test('release.sh aborts when not on main', () => {
  const res = runWithGitStub(`
case "$1" in
  rev-parse) [ "$2" = "--abbrev-ref" ] && { echo feature-branch; exit 0; }; echo x ;;
  diff) exit 0 ;;
  *) exit 0 ;;
esac`);
  assert.equal(res.status, 1);
  assert.match(res.stdout + res.stderr, /must run on main/i);
});

test('release.sh aborts when ff-only pull fails (diverged from origin)', () => {
  const res = runWithGitStub(`
case "$1" in
  rev-parse) [ "$2" = "--abbrev-ref" ] && { echo main; exit 0; }; echo x ;;
  diff) exit 0 ;;
  pull) echo "fatal: Not possible to fast-forward" >&2; exit 128 ;;
  *) exit 0 ;;
esac`);
  assert.equal(res.status, 1);
  assert.match(res.stdout + res.stderr, /fast-forward|pull/i);
});

test('release.sh rejects the removed --skip-tests flag', () => {
  const res = runWithGitStub('exit 0', ['patch', '--skip-tests']);
  assert.equal(res.status, 1);
  assert.match(res.stdout + res.stderr, /skip-tests.*removed|unknown flag/i);
});
