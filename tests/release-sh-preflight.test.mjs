import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, accessSync, constants } from 'node:fs';
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

// The first executable named `name` on the real PATH, or null.
function resolveOnPath(name) {
  for (const d of (process.env.PATH || '').split(':').filter(Boolean)) {
    const candidate = join(d, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

// A PATH on which `gh` genuinely does not exist.
//
// The first version of this deleted every PATH entry that contained a gh. That
// removes a directory to remove one file, and on ubuntu `gh` and `bash` are both
// in /usr/bin -- so the filter deleted the shell, release.sh never ran, and
// `spawnSync` returned status null. It passed on macOS only because homebrew
// puts gh somewhere the shell is not. The gate this file tests exists because a
// suite that runs on one OS cannot fail for the others; its own test was an
// instance of that.
//
// So build the sandbox up instead of tearing PATH down: link in exactly what
// release.sh needs to reach the gh check -- bash to run it, node to read the
// version, dirname to resolve its own directory -- and let PATH be that one
// directory. Nothing else is reachable, which is the precondition the test
// claims.
function sandboxWithoutGh(dir) {
  for (const name of ['bash', 'node', 'dirname']) {
    const real = name === 'node' ? process.execPath : resolveOnPath(name);
    if (!real) throw new Error(`cannot build a gh-less sandbox: no ${name} on PATH`);
    symlinkSync(real, join(dir, name));
  }
  return dir;
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
  const res = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      PATH: omitGh ? sandboxWithoutGh(dir) : `${dir}:${process.env.PATH}`,
    },
  });
  // A script that never started has `status: null`, which every caller below
  // then reports as `null !== 1` -- an assertion about release.sh's exit code,
  // for a release.sh that did not run. Name it here once instead.
  if (res.error) {
    throw new Error(`release.sh did not start (${res.error.code}): ${res.error.message}`);
  }
  return res;
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
