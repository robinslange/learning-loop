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

describe('install-shims Windows cmd shim content', () => {
  // Spawn a child that pretends process.platform === 'win32' by monkey-patching
  // before import, writes shims to a temp dir, then prints them to stdout.
  // We do NOT actually run the shims — we verify their textual content.
  it('cmd shims hand their name to node and carry nothing cmd.exe would expand', () => {
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

// Run the installer. A file:// URL, not a bare path: an absolute Windows
// path is not a valid ESM specifier ("Received protocol 'd:'"), and posix
// accepts both, so this only ever fails on the runner nobody develops on.
await import(${JSON.stringify(pathToFileURL(SCRIPT).href + '?bust=' + Date.now())});

const shims = Object.fromEntries(
  ${JSON.stringify(SHIM_NAMES)}.map((name) => [
    name,
    readFileSync(join(fakeHome, '.local', 'bin', name + '.cmd'), 'utf-8'),
  ]),
);
writeFileSync(join(fakeHome, 'shims.json'), JSON.stringify(shims));
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

    const shims = JSON.parse(readFileSync(join(fakeHome, 'shims.json'), 'utf-8'));
    assert.deepEqual(Object.keys(shims).sort(), [...SHIM_NAMES].sort());
    for (const [name, text] of Object.entries(shims)) {
      assert.match(text, /^@echo off\r\n/, `${name}: starts with @echo off`);
      assert.doesNotMatch(text, /#!|\/bin\/(ba)?sh/, `${name}: no POSIX syntax`);
      if (name === 'll-search') continue;
      assert.match(
        text,
        new RegExp(`node -e "[^"]*" -- ${name} %\\*\\r\\n$`),
        `${name}: hands its name to node`,
      );
      const setlocalIdx = text.indexOf('setlocal DisableDelayedExpansion');
      const nodeIdx = text.indexOf('node -e');
      assert.ok(setlocalIdx !== -1, `${name}: disables delayed expansion`);
      assert.ok(
        setlocalIdx !== -1 && nodeIdx !== -1 && setlocalIdx < nodeIdx,
        `${name}: disables delayed expansion before invoking node, so cmd.exe never reads the ! in LOCATE as a variable reference`,
      );
      assert.match(
        text,
        /installed_plugins\.json/,
        `${name}: finds the install through Claude Code's record`,
      );
      assert.doesNotMatch(text, /%(?!\*\r\n$)/, `${name}: no % for cmd.exe to expand except %*`);
    }
    const search = shims['ll-search'];
    assert.match(search, /ll-search\.exe/, 'search: runs the .exe');
    assert.match(search, /ORT_DYLIB_PATH/, 'search: sets ORT_DYLIB_PATH');
    assert.match(search, /ORT_LIB_LOCATION/, 'search: sets ORT_LIB_LOCATION');
    assert.match(search, /USERPROFILE/, 'search: falls back through USERPROFILE');
    rmSync(fakeHome, { recursive: true, force: true });
  });
});
