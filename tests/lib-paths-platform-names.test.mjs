// Contract test for the platform-dependent FILE NAME helpers in paths.mjs.
//
// Both exist for the same reason: the name on disk differs by platform, and
// every reader has to agree with the writer about it. Getting either wrong is
// invisible from the machine that finds the bug -- the POSIX spelling is
// correct everywhere except the one platform where it is not, so a POSIX CI
// runner and a POSIX developer both see green. That is how the health check
// shipped four missing shims (fixed in 5bdbc6b) and a missing binary (#3) on
// correct Windows installs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { shimFileName, binaryFileName, SHIM_NAMES } from '../plugin/scripts/lib/paths.mjs';

const PLUGIN_DIR = join(import.meta.dirname, '..', 'plugin');

// paths.mjs is the authority. install-shims.mjs embeds the name inside the
// generated `.cmd` text it writes, which is cmd.exe source, not a JS path.
const MAY_SPELL_THE_NAME = new Set([
  join('scripts', 'lib', 'paths.mjs'),
  join('scripts', 'install-shims.mjs'),
]);

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'vendor') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(full);
    else if (/\.(mjs|js)$/.test(entry.name)) yield full;
  }
}

test('binaryFileName spells the binary the way each platform writes it', () => {
  assert.equal(binaryFileName('win32'), 'll-search.exe');
  assert.equal(binaryFileName('darwin'), 'll-search');
  assert.equal(binaryFileName('linux'), 'll-search');
});

test('binaryFileName defaults to the running platform', () => {
  assert.equal(binaryFileName(), process.platform === 'win32' ? 'll-search.exe' : 'll-search');
});

test('shimFileName spells every installer shim the way each platform writes it', () => {
  for (const name of SHIM_NAMES) {
    assert.equal(shimFileName(name, 'win32'), `${name}.cmd`);
    assert.equal(shimFileName(name, 'linux'), name);
  }
});

test('shimFileName refuses a name the installer does not write', () => {
  // The throw is the point: a typo'd shim name must not resolve to a path that
  // merely does not exist, because every caller treats absent as "reinstall".
  assert.throws(() => shimFileName('ll-nope', 'linux'), /not in SHIM_NAMES/);
});

// Guards the bug CLASS rather than the two instances of it that were found.
// Every call site that spells the name itself is a site that can be forgotten,
// and forgetting is invisible from POSIX -- so the spelling may exist in one
// place only. A new consumer must import binaryFileName() instead.
test('paths.mjs is the only source file that spells the Windows binary name', () => {
  const offenders = [];
  for (const file of sourceFiles(PLUGIN_DIR)) {
    const rel = relative(PLUGIN_DIR, file);
    if (MAY_SPELL_THE_NAME.has(rel)) continue;
    if (readFileSync(file, 'utf8').includes('ll-search.exe')) offenders.push(rel);
  }
  assert.deepEqual(
    offenders,
    [],
    'these files carry their own copy of the win32 binary name -- import binaryFileName() from lib/paths.mjs instead',
  );
});
