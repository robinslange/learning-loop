import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectAbiDrift } from '../scripts/check-deps.mjs';

test('detectAbiDrift returns ok when no error is supplied', () => {
  const result = detectAbiDrift({ nativeModulePath: null, currentAbi: process.versions.modules });
  assert.equal(result.status, 'ok');
});

test('detectAbiDrift returns mismatch with extracted plugin directory in fix message', () => {
  const result = detectAbiDrift({
    nativeModulePath: '/home/user/.claude/plugins/cache/superpowers-marketplace/episodic-memory/1.0.15/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
    currentAbi: process.versions.modules,
    fakeLoadError: new Error(
      'The module was compiled against a different Node.js version using NODE_MODULE_VERSION 137. This version of Node.js requires NODE_MODULE_VERSION 141.'
    ),
  });
  assert.equal(result.status, 'abi-mismatch');
  assert.equal(result.expectedAbi, '137');
  assert.match(
    result.fix,
    /npm rebuild.+episodic-memory\/1\.0\.15\//,
    'fix should name the plugin directory, not the raw .node path',
  );
});

test('detectAbiDrift prefers currentAbi over parsed actual when supplied', () => {
  const result = detectAbiDrift({
    nativeModulePath: '/x',
    currentAbi: '999',
    fakeLoadError: new Error(
      'compiled against NODE_MODULE_VERSION 137. This version of Node.js requires NODE_MODULE_VERSION 141.'
    ),
  });
  assert.equal(result.actualAbi, '999');
});

test('detectAbiDrift returns error status for unrelated load failures', () => {
  const result = detectAbiDrift({
    nativeModulePath: '/nope',
    currentAbi: process.versions.modules,
    fakeLoadError: new Error('Cannot find module /nope'),
  });
  assert.equal(result.status, 'error');
  assert.match(result.message, /Cannot find module/);
});
