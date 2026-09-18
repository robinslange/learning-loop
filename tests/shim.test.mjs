// The ~/.local/bin shims are written once and outlive every plugin version, so
// they only locate the active install and hand off to its scripts/shim.mjs.
// These run the rendered POSIX shim for real against a sandbox HOME.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderShim } from '../plugin/scripts/lib/shims.mjs';
import { INSTALL_KEY } from '../plugin/scripts/lib/plugin-meta.mjs';
import { SHIM_NAMES } from '../plugin/scripts/lib/paths.mjs';
import { checkShimsExist } from '../plugin/scripts/lib/health-checks/quick.mjs';
import { skipOnWindows } from './helpers/platform.mjs';

const REPO_PLUGIN = realpathSync(fileURLToPath(new URL('../plugin', import.meta.url)));
const posixOnly = {
  skip: skipOnWindows('runs the POSIX shim; .cmd text is covered in install-shims.test.mjs'),
};

function sandbox() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'll-shim-')));
  const bin = join(home, '.local', 'bin');
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
  for (const name of SHIM_NAMES) {
    writeFileSync(join(bin, name), renderShim(name, 'linux'));
    chmodSync(join(bin, name), 0o755);
  }
  return {
    home,
    installClaude: (installPath) =>
      writeFileSync(
        join(home, '.claude', 'plugins', 'installed_plugins.json'),
        JSON.stringify({
          version: 2,
          plugins: { [INSTALL_KEY]: [{ scope: 'user', installPath }] },
        }),
      ),
    run: (name, args = [], extraEnv = {}) =>
      spawnSync(join(bin, name), args, {
        encoding: 'utf8',
        timeout: 15000,
        env: { ...process.env, HOME: home, CLAUDE_PLUGIN_DATA: join(home, 'data'), ...extraEnv },
      }),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

test('shim text carries no machine or version path, so every version renders the same bytes', () => {
  for (const platform of ['linux', 'win32']) {
    for (const name of SHIM_NAMES) {
      const text = renderShim(name, platform);
      assert.doesNotMatch(text, /\/Users\/|\/home\/|[A-Z]:\\|\d+\.\d+\.\d+/, `${platform} ${name}`);
    }
  }
});

test('ll-paths answers from the install Claude Code has active', posixOnly, () => {
  const s = sandbox();
  try {
    s.installClaude(REPO_PLUGIN);
    const field = s.run('ll-paths', ['PLUGIN']);
    assert.equal(field.status, 0, field.stderr);
    assert.equal(field.stdout.trim(), REPO_PLUGIN);

    const sh = s.run('ll-paths', ['--sh']);
    assert.equal(sh.status, 0, `--sh must reach resolve-paths, not node: ${sh.stderr}`);
    assert.ok(sh.stdout.includes(REPO_PLUGIN), sh.stdout);
  } finally {
    s.cleanup();
  }
});

test('ll-run finds scripts under scripts/ and bin/, and names a missing one', posixOnly, () => {
  const s = sandbox();
  try {
    s.installClaude(REPO_PLUGIN);
    const script = s.run('ll-run', ['resolve-paths.mjs', 'PLUGIN']);
    assert.equal(script.status, 0, script.stderr);
    assert.equal(script.stdout.trim(), REPO_PLUGIN);

    const gateway = s.run('ll-run', ['source-gateway.mjs']);
    assert.equal(gateway.status, 2, gateway.stderr);
    assert.match(
      gateway.stderr,
      /Usage: source-gateway\.mjs/,
      'bin/source-gateway.mjs ran as the main module and rejected the missing verb',
    );

    const missing = s.run('ll-run', ['nope.mjs']);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /no such learning-loop script: nope\.mjs/);
  } finally {
    s.cleanup();
  }
});

// ll-search is the hot path (skills call it in loops), so it never starts node:
// 6ms as a builtins-only sh shim against 34ms routed through node (2026-09-15).
test('ll-search never starts node', () => {
  assert.doesNotMatch(renderShim('ll-search', 'linux'), /\bnode\b/);
  assert.doesNotMatch(renderShim('ll-search', 'win32'), /\bnode\b/);
});

function stubBinary(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'll-search'),
    '#!/bin/sh\necho "args:$* ort:${ORT_DYLIB_PATH:-none}"\nexit 3\n',
  );
  chmodSync(join(dir, 'll-search'), 0o755);
}

test(
  'll-search runs the plugin-data binary with its arguments, exit code and ORT env',
  posixOnly,
  () => {
    const s = sandbox();
    try {
      const binDir = join(s.home, 'data', 'bin');
      stubBinary(binDir);

      const bare = s.run('ll-search', ['search', '--top', '5']);
      assert.equal(bare.status, 3, bare.stderr);
      assert.equal(
        bare.stdout.trim(),
        'args:search --top 5 ort:none',
        'no runtime library staged, no ORT env',
      );

      writeFileSync(join(binDir, 'libonnxruntime.dylib'), '');
      const staged = s.run('ll-search', ['version']);
      assert.equal(staged.stdout.trim(), `args:version ort:${binDir}`);
    } finally {
      s.cleanup();
    }
  },
);

test(
  'll-search falls back to the saved marker when CLAUDE_PLUGIN_DATA has no binary',
  posixOnly,
  () => {
    const s = sandbox();
    try {
      const marked = join(s.home, 'marked');
      stubBinary(join(marked, 'bin'));
      mkdirSync(join(s.home, '.claude', 'plugins', 'data'), { recursive: true });
      writeFileSync(join(s.home, '.claude', 'plugins', 'data', '.ll-data-path'), marked);
      const r = s.run('ll-search', ['version'], { CLAUDE_PLUGIN_DATA: join(s.home, 'empty') });
      assert.equal(r.status, 3, r.stderr);
      assert.equal(r.stdout.trim(), 'args:version ort:none');
    } finally {
      s.cleanup();
    }
  },
);

test('ll-watch --help runs watch.mjs', posixOnly, () => {
  const s = sandbox();
  try {
    s.installClaude(REPO_PLUGIN);
    const r = s.run('ll-watch', ['--help']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Usage:/);
  } finally {
    s.cleanup();
  }
});

test(
  'without a Claude Code install the newest Codex version wins, compared as numbers',
  posixOnly,
  () => {
    const s = sandbox();
    try {
      const cache = join(
        s.home,
        '.codex',
        'plugins',
        'cache',
        'learning-loop-marketplace',
        'learning-loop',
      );
      mkdirSync(join(cache, '1.9.0'), { recursive: true });
      symlinkSync(REPO_PLUGIN, join(cache, '1.10.0'));
      const r = s.run('ll-paths', ['PLUGIN']);
      assert.equal(r.status, 0, `a string sort picks the empty 1.9.0: ${r.stderr}`);
      assert.equal(r.stdout.trim(), REPO_PLUGIN);
    } finally {
      s.cleanup();
    }
  },
);

test('a stale installed_plugins.json record falls through to the Claude cache', posixOnly, () => {
  const s = sandbox();
  try {
    s.installClaude(join(s.home, 'gone', 'nowhere'));
    const cache = join(
      s.home,
      '.claude',
      'plugins',
      'cache',
      'learning-loop-marketplace',
      'learning-loop',
    );
    mkdirSync(join(cache, '1.2.3'), { recursive: true });
    symlinkSync(REPO_PLUGIN, join(cache, '9.9.9'));
    const r = s.run('ll-paths', ['PLUGIN']);
    assert.equal(r.status, 0, `a dead installPath must not hard-fail: ${r.stderr}`);
    assert.equal(r.stdout.trim(), REPO_PLUGIN);
  } finally {
    s.cleanup();
  }
});

test('with no install anywhere the shim says so and exits 1', posixOnly, () => {
  const s = sandbox();
  try {
    const r = s.run('ll-run', ['health-check.mjs']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /learning-loop is not installed/);
  } finally {
    s.cleanup();
  }
});

// checkShimsExist mirrors LOCATE's candidate walk in real JS, so the copy and
// the original can drift apart silently. This runs the rendered shim and the
// health check against ONE sandbox and requires them to agree in BOTH
// directions: a check that agreed only when things already work is exactly what
// reported four dead 2.0.7 shims as ready.
test('the health check and the shim agree on whether an install resolves', posixOnly, () => {
  const s = sandbox();
  try {
    // Nothing resolvable: the shim exits 1, so the check must not say ready.
    assert.equal(s.run('ll-paths', ['PLUGIN']).status, 1);
    assert.equal(checkShimsExist({ home: s.home }).status, 'fail');

    // A root that resolves: the shim answers, so the check must say ready.
    const cache = join(
      s.home,
      '.claude',
      'plugins',
      'cache',
      'learning-loop-marketplace',
      'learning-loop',
    );
    mkdirSync(cache, { recursive: true });
    symlinkSync(REPO_PLUGIN, join(cache, '9.9.9'));

    assert.equal(s.run('ll-paths', ['PLUGIN']).status, 0);
    assert.equal(checkShimsExist({ home: s.home }).status, 'ok');
  } finally {
    s.cleanup();
  }
});
