import { execFileSync } from 'child_process';
import { join, resolve, dirname } from 'path';
import { existsSync, readdirSync } from 'fs';
import { getPluginData } from './config.mjs';
import { warnOnce } from './warn-once.mjs';
import { spawnEnv } from './env.mjs';

// True when an ONNX Runtime shared library is staged in `dir`. Keyed on the
// library name prefix (not a version-pinned filename) so it never drifts from
// the Rust-side pin in ll-core/src/dylib.rs.
function hasOrtLibrary(dir) {
  try {
    return readdirSync(dir).some(
      (f) => /^libonnxruntime/.test(f) || /^onnxruntime.*\.dll$/i.test(f),
    );
  } catch {
    return false;
  }
}

// Build the spawn env for a child ll-search. Point ORT_DYLIB_PATH/ORT_LIB_LOCATION
// at the binary's directory ONLY when a runtime library is actually staged there
// (the co-located-install convention). Otherwise inject nothing, so the binary
// self-resolves (~/.learning-loop/lib) or honors an operator-set ORT_DYLIB_PATH /
// LL_ORT_DIR flowing through the ambient env. Injecting an empty directory would
// clobber that resolution and turn a working install into a load failure.
export function ortSpawnEnv(binDir) {
  if (binDir && hasOrtLibrary(binDir)) {
    return spawnEnv({ ORT_DYLIB_PATH: binDir, ORT_LIB_LOCATION: binDir });
  }
  return spawnEnv({});
}

const BINARY_NAME = process.platform === 'win32' ? 'll-search.exe' : 'll-search';

function findBinary() {
  const pluginData = getPluginData();
  if (pluginData) {
    const installed = join(pluginData, 'bin', BINARY_NAME);
    if (existsSync(installed)) return installed;
  }

  const devBuild = resolve(
    join(import.meta.dirname, '..', '..', '..', 'native', 'target', 'release', BINARY_NAME),
  );
  if (existsSync(devBuild)) return devBuild;

  return null;
}

let _binaryPath = null;

export function binaryPath() {
  if (_binaryPath !== null) return _binaryPath;
  _binaryPath = findBinary();
  return _binaryPath;
}

// Test-only: clear the cached path so the next binaryPath() call re-runs
// findBinary(). Lets tests swap in/out a stub binary without spawning fresh
// node processes. Do not call from production code.
export function __resetBinaryCacheForTesting() {
  _binaryPath = null;
}

export function hasBinary() {
  return binaryPath() !== null;
}

export function binaryVersion() {
  if (!hasBinary()) return null;
  try {
    return runRaw(['version']).trim();
  } catch (_err) {
    return null;
  }
}

export function run(args, { maxBuffer = 50 * 1024 * 1024 } = {}) {
  const bin = binaryPath();
  if (!bin) {
    warnOnce(
      'll-search-missing',
      'learning-loop: ll-search binary not found. Run /learning-loop:init to install.\n',
    );
    throw new Error('ll-search binary not found. Run /learning-loop:init to install.');
  }

  const stdout = execFileSync(bin, args, {
    encoding: 'utf-8',
    maxBuffer,
    env: ortSpawnEnv(dirname(bin)),
  });
  return JSON.parse(stdout);
}

export function runRaw(args, { maxBuffer = 50 * 1024 * 1024 } = {}) {
  const bin = binaryPath();
  if (!bin) {
    warnOnce(
      'll-search-missing',
      'learning-loop: ll-search binary not found. Run /learning-loop:init to install.\n',
    );
    throw new Error('ll-search binary not found. Run /learning-loop:init to install.');
  }

  return execFileSync(bin, args, {
    encoding: 'utf-8',
    maxBuffer,
    env: ortSpawnEnv(dirname(bin)),
  });
}
