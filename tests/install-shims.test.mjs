import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { SHIM_NAMES } from '../plugin/scripts/lib/paths.mjs';

const SCRIPT = join(import.meta.dirname, '..', 'plugin', 'scripts', 'install-shims.mjs');

describe('install-shims --check (macOS smoke test)', () => {
  it('exits 0 and prints shim paths', () => {
    const result = spawnSync('node', [SCRIPT, '--check'], { encoding: 'utf-8' });
    assert.equal(result.status, 0, `exited non-zero: ${result.stderr}`);
    for (const name of SHIM_NAMES) {
      assert.match(result.stdout, new RegExp(`${name}:`));
    }
  });

  it('reports installed or missing for each shim', () => {
    const result = spawnSync('node', [SCRIPT, '--check'], { encoding: 'utf-8' });
    assert.equal(result.status, 0);
    // Against SHIM_NAMES, not a hardcoded count: a shim added to the installer
    // and not to this list would leave the check silently reporting a subset,
    // which is how a new shim reaches nobody.
    const lines = result.stdout.trim().split('\n');
    assert.equal(lines.length, SHIM_NAMES.length);
    for (const line of lines) {
      assert.match(line, /(?:installed|missing)/);
    }
    for (const name of SHIM_NAMES) {
      assert.ok(
        lines.some((l) => l.startsWith(`${name}:`)),
        `--check must report ${name}; got:\n${result.stdout}`,
      );
    }
  });

  it('check output includes the expected bin directory path', () => {
    const result = spawnSync('node', [SCRIPT, '--check'], { encoding: 'utf-8' });
    assert.equal(result.status, 0);
    const expectedBinDir = join(homedir(), '.local', 'bin');
    assert.ok(
      result.stdout.includes(expectedBinDir),
      `expected bin dir ${expectedBinDir} in output: ${result.stdout}`,
    );
  });
});

describe('install-shims Windows cmd shim content (unit test via node -e override)', () => {
  // Spawn a child that pretends process.platform === 'win32' by monkey-patching
  // before import, writes shims to a temp dir, then prints them to stdout.
  // We do NOT actually run the shims — we verify their textual content.
  it('cmd shims contain @echo off, setlocal, and no bash syntax', () => {
    const snippet = `
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Override platform before the script under test loads.
Object.defineProperty(process, 'platform', { value: 'win32' });

// HOME/USERPROFILE are set by the parent before this runs; os.homedir()
// reads them, which is what keeps the shims out of the real ~/.local/bin.
const fakeHome = homedir();
mkdirSync(join(fakeHome, '.local', 'bin'), { recursive: true });
mkdirSync(join(fakeHome, '.claude', 'plugins', 'cache',
  'learning-loop-marketplace', 'learning-loop', '1.0.0'), { recursive: true });

// Provide a fake CLAUDE_PLUGIN_ROOT so getPluginRoot doesn't throw.
process.env.CLAUDE_PLUGIN_ROOT = join(fakeHome, '.claude', 'plugins', 'cache',
  'learning-loop-marketplace', 'learning-loop', '1.0.0');

// Run the installer. A file:// URL, not a bare path: an absolute Windows
// path is not a valid ESM specifier ("Received protocol 'd:'"), and posix
// accepts both, so this only ever fails on the runner nobody develops on.
await import(${JSON.stringify(pathToFileURL(SCRIPT).href + '?bust=' + Date.now())});

// Read back what was written.
const watchCmd = readFileSync(join(fakeHome, '.local', 'bin', 'll-watch.cmd'), 'utf-8');
const searchCmd = readFileSync(join(fakeHome, '.local', 'bin', 'll-search.cmd'), 'utf-8');
const pathsCmd = readFileSync(join(fakeHome, '.local', 'bin', 'll-paths.cmd'), 'utf-8');

// Through a file, not stdout: the installer prints its own "Wrote ..." lines
// there and they are not JSON.
writeFileSync(join(fakeHome, 'shims.json'), JSON.stringify({ watchCmd, searchCmd, pathsCmd }));
`;
    const fakeHome = mkdtempSync(join(tmpdir(), 'shim-test-'));
    const result = spawnSync('node', ['--input-type=module'], {
      input: snippet,
      encoding: 'utf-8',
      timeout: 15000,
      env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
    });

    // No inconclusive branch. This test spent its whole life printing
    // "inconclusive" and returning green: the child patched `os.homedir` after
    // the installer had already bound it as an ESM named import, so the shims
    // went to the REAL ~/.local/bin and the reads from the temp dir threw
    // ENOENT. It asserted nothing about Windows for as long as it existed, and
    // littered the developer's own bin directory on every run. A test that
    // passes when it did no work is worse than no test, because it reads as
    // coverage.
    assert.equal(result.status, 0, `child failed: ${result.stderr?.slice(0, 600)}`);

    const { watchCmd, searchCmd, pathsCmd } = JSON.parse(
      readFileSync(join(fakeHome, 'shims.json'), 'utf-8'),
    );

    // ll-watch.cmd assertions
    assert.match(watchCmd, /@echo off/, 'watch: starts with @echo off');
    assert.match(watchCmd, /setlocal enabledelayedexpansion/, 'watch: setlocal');
    assert.match(watchCmd, /CACHE_DIR=/, 'watch: sets CACHE_DIR');
    assert.match(watchCmd, /node.*scripts\\watch\.mjs/, 'watch: invokes node');
    assert.doesNotMatch(watchCmd, /#!/, 'watch: no shebang');
    assert.doesNotMatch(watchCmd, /\/bin\/bash/, 'watch: no bash');

    // ll-search.cmd assertions
    assert.match(searchCmd, /@echo off/, 'search: starts with @echo off');
    assert.match(searchCmd, /setlocal enabledelayedexpansion/, 'search: setlocal');
    assert.match(searchCmd, /ORT_DYLIB_PATH/, 'search: sets ORT_DYLIB_PATH');
    assert.match(searchCmd, /ORT_LIB_LOCATION/, 'search: sets ORT_LIB_LOCATION');
    assert.match(searchCmd, /ll-search\.exe/, 'search: invokes .exe');
    assert.match(searchCmd, /USERPROFILE/, 'search: uses USERPROFILE');
    assert.doesNotMatch(searchCmd, /#!/, 'search: no shebang');
    assert.doesNotMatch(searchCmd, /\/bin\/bash/, 'search: no bash');

    // ll-paths.cmd assertions. Without these the bootstrap every Bash block in
    // the plugin now depends on would be verified on POSIX only — a guard that
    // stops guarding on one platform, which is where the last one went.
    assert.match(pathsCmd, /@echo off/, 'paths: starts with @echo off');
    assert.match(pathsCmd, /setlocal enabledelayedexpansion/, 'paths: setlocal');
    assert.match(pathsCmd, /CACHE_DIR=/, 'paths: sets CACHE_DIR');
    assert.match(pathsCmd, /node.*scripts\\resolve-paths\.mjs/, 'paths: invokes resolve-paths.mjs');
    assert.doesNotMatch(pathsCmd, /#!/, 'paths: no shebang');
    assert.doesNotMatch(pathsCmd, /\/bin\/bash/, 'paths: no bash');
    rmSync(fakeHome, { recursive: true, force: true });
  });
});
