import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, accessSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { skipOnWindows } from './helpers/platform.mjs';

const SKIP = skipOnWindows(
  'bash: release.sh and stub executables require bash/shebang, not available on win32',
);

const SCRIPT = join(import.meta.dirname, '..', 'release.sh');

// A git stub that gets as far as the CI gate: on main, clean tree, pull succeeds.
const GIT_REACHES_CI_GATE = `
case "$1" in
  rev-parse)
    [ "$2" = "--abbrev-ref" ] && { echo main; exit 0; }
    echo deadbeefcafe; exit 0 ;;
  diff) exit 0 ;;
  pull) exit 0 ;;
  *) exit 0 ;;
esac`;

// PATH entries with no gh in them, so `command -v gh` genuinely fails rather
// than finding the real one behind the stub dir.
function pathWithoutGh(stubDir) {
  const kept = (process.env.PATH || '')
    .split(':')
    .filter(Boolean)
    .filter((d) => {
      try {
        accessSync(join(d, 'gh'), constants.X_OK);
        return false;
      } catch {
        return true;
      }
    });
  return [stubDir, ...kept].join(':');
}

function runWithGitStub(stubBody, args = ['patch'], opts = {}) {
  const { ghStub = null, omitGh = false } = opts;
  const dir = mkdtempSync(join(tmpdir(), 'll-rel-'));
  const stub = join(dir, 'git');
  writeFileSync(stub, `#!/usr/bin/env bash\n${stubBody}\n`);
  chmodSync(stub, 0o755);
  const contained = ['npm', 'npx', 'perl', 'cargo'];
  // gh is contained by default so no test can reach the network; a test that
  // is about the CI gate supplies its own.
  if (!ghStub && !omitGh) contained.push('gh');
  for (const name of contained) {
    const containment = join(dir, name);
    writeFileSync(
      containment,
      `#!/usr/bin/env bash\necho "STUB: ${name} should not be reached" >&2\nexit 1\n`,
    );
    chmodSync(containment, 0o755);
  }
  if (ghStub) {
    const gh = join(dir, 'gh');
    writeFileSync(gh, `#!/usr/bin/env bash\n${ghStub}\n`);
    chmodSync(gh, 0o755);
  }
  return spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      PATH: omitGh ? pathWithoutGh(dir) : `${dir}:${process.env.PATH}`,
    },
  });
}

test('release.sh aborts when not on main', { skip: SKIP }, () => {
  const res = runWithGitStub(`
case "$1" in
  rev-parse) [ "$2" = "--abbrev-ref" ] && { echo feature-branch; exit 0; }; echo x ;;
  diff) exit 0 ;;
  *) exit 0 ;;
esac`);
  assert.equal(res.status, 1);
  assert.match(res.stdout + res.stderr, /must run on main/i);
});

test('release.sh aborts when ff-only pull fails (diverged from origin)', { skip: SKIP }, () => {
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

test('release.sh rejects the removed --skip-tests flag', { skip: SKIP }, () => {
  const res = runWithGitStub('exit 0', ['patch', '--skip-tests']);
  assert.equal(res.status, 1);
  assert.match(res.stdout + res.stderr, /skip-tests.*removed|unknown flag/i);
});

// The CI gate. v2.0.0 was tagged on a commit whose Windows job was red, because
// the only gate was a suite running on the operator's own OS. Each case below
// is a way the gate could pass without having established anything.

test('release.sh aborts when no CI has reported on the base commit', { skip: SKIP }, () => {
  const res = runWithGitStub(GIT_REACHES_CI_GATE, ['patch'], { ghStub: 'exit 0' });
  assert.equal(res.status, 1);
  assert.match(res.stdout + res.stderr, /no CI has reported/i);
});

test('release.sh aborts while CI is still running', { skip: SKIP }, () => {
  const res = runWithGitStub(GIT_REACHES_CI_GATE, ['patch'], {
    ghStub: `printf 'completed\\tsuccess\\tlint\\nin_progress\\tnone\\tnode (windows-latest)\\n'`,
  });
  assert.equal(res.status, 1);
  assert.match(res.stdout + res.stderr, /still running/i);
  assert.match(res.stdout + res.stderr, /node \(windows-latest\)/);
});

test('release.sh aborts when a check failed, and names it', { skip: SKIP }, () => {
  const res = runWithGitStub(GIT_REACHES_CI_GATE, ['patch'], {
    ghStub: `printf 'completed\\tsuccess\\tlint\\ncompleted\\tfailure\\tnode (windows-latest)\\n'`,
  });
  assert.equal(res.status, 1);
  assert.match(res.stdout + res.stderr, /not green/i);
  assert.match(res.stdout + res.stderr, /node \(windows-latest\) \(failure\)/);
});

test('release.sh aborts on a cancelled check, not just a failed one', { skip: SKIP }, () => {
  const res = runWithGitStub(GIT_REACHES_CI_GATE, ['patch'], {
    ghStub: `printf 'completed\\tcancelled\\tcargo\\n'`,
  });
  assert.equal(res.status, 1);
  assert.match(res.stdout + res.stderr, /not green/i);
  assert.match(res.stdout + res.stderr, /cargo \(cancelled\)/);
});

test(
  'release.sh aborts when gh cannot answer, rather than passing vacuously',
  { skip: SKIP },
  () => {
    const res = runWithGitStub(GIT_REACHES_CI_GATE, ['patch'], {
      ghStub: 'echo "gh: HTTP 401 Bad credentials" >&2\nexit 1',
    });
    assert.equal(res.status, 1);
    assert.match(res.stdout + res.stderr, /could not read CI status/i);
  },
);

test('release.sh aborts when gh is not installed', { skip: SKIP }, () => {
  const res = runWithGitStub(GIT_REACHES_CI_GATE, ['patch'], { omitGh: true });
  assert.equal(res.status, 1);
  assert.match(res.stdout + res.stderr, /gh is not installed/i);
});

test('a green commit passes the gate and reaches the test suite', { skip: SKIP }, () => {
  const res = runWithGitStub(GIT_REACHES_CI_GATE, ['patch'], {
    ghStub: `printf 'completed\\tsuccess\\tlint\\ncompleted\\tskipped\\tinstall-script\\ncompleted\\tneutral\\tquality\\n'`,
  });
  // The gate passed: it said so, and control reached the prettier step, which
  // the containment stub kills. Asserting only on "CI green" would also pass if
  // the gate had been deleted outright.
  assert.match(res.stdout, /CI green on deadbeefcafe \(3 checks\)/);
  assert.match(res.stdout + res.stderr, /STUB: npx should not be reached/);
});
