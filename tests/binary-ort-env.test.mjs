import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ortSpawnEnv } from '../plugin/scripts/lib/binary.mjs';

// ortSpawnEnv must only point ORT_DYLIB_PATH at the binary's directory when an
// ONNX Runtime library is actually staged there. Injecting an empty directory
// clobbers the binary's own resolution (which falls back to ~/.learning-loop/lib
// or an operator-set override), turning a working install into a load failure.

test('injects ORT_DYLIB_PATH/ORT_LIB_LOCATION when a dylib is present in binDir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ort-present-'));
  try {
    // Any platform library name; the helper keys on the libonnxruntime/onnxruntime
    // prefix, not a hardcoded version, to avoid drifting from the Rust pin.
    writeFileSync(join(dir, 'libonnxruntime.1.24.2.dylib'), 'x');
    const env = ortSpawnEnv(dir);
    assert.equal(env.ORT_DYLIB_PATH, dir);
    assert.equal(env.ORT_LIB_LOCATION, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('does NOT inject when binDir has no ONNX Runtime library', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ort-absent-'));
  try {
    writeFileSync(join(dir, 'll-search'), 'x'); // binary only, no dylib
    const env = ortSpawnEnv(dir);
    assert.equal(env.ORT_DYLIB_PATH, undefined, 'must not clobber binary self-resolution');
    assert.equal(env.ORT_LIB_LOCATION, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preserves an operator-set ambient ORT_DYLIB_PATH when not injecting', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ort-ambient-'));
  const prev = process.env.ORT_DYLIB_PATH;
  try {
    process.env.ORT_DYLIB_PATH = '/operator/provided/libonnxruntime.so';
    const env = ortSpawnEnv(dir); // dir has no dylib → must not overwrite operator value
    assert.equal(env.ORT_DYLIB_PATH, '/operator/provided/libonnxruntime.so');
  } finally {
    if (prev === undefined) delete process.env.ORT_DYLIB_PATH;
    else process.env.ORT_DYLIB_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
